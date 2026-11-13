/**
 * 自适应增量压缩治理（预设层插件，挂在 compaction 隔离组里）。
 *
 * 为什么需要它：官方压缩只在窗口用满 80% 时触发，而且一次把最老的一大段
 * 历史替换成一条摘要。实测 36 次压缩里，中位数一次删掉 49 万 token、
 * 只换回 1.3 万字符摘要；压缩后模型反复重读文件、重跑命令。
 *
 * 本插件的策略（不使用固定窗口百分比）：
 * 1. 触发条件按「工作集」判断：工作集 = 系统提示 + 请求固定开销 +
 *    最近若干步的消息。上下文超过工作集的 slack 倍才考虑压缩。
 * 2. 只在轮次边界动手（每轮第一步），避免把任务状态从步骤中间切走。
 * 3. 每次只压最老的一段，把上下文压回工作集的 keepFactor 倍就停。
 * 4. 防抖：两次压缩之间至少 minStepsBetween 步，且新增量不足时不动。
 * 5. 官方 80% 阈值保留为安全兜底；本插件只做更早、更小步的压缩。
 *
 * 任何异常都只记录并放行，绝不打断本轮对话。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULTS = {
  enabled: true,
  /** 上下文超过工作集的多少倍才考虑压缩。 */
  slack: 3,
  /** 压缩后希望上下文回到工作集的多少倍。 */
  keepFactor: 1.5,
  /** 两次压缩之间至少经过多少步。 */
  minStepsBetween: 25,
  /** 距上次压缩的增量至少达到工作集的多少倍才允许再压。 */
  minGrowthRatio: 1,
  /** 估算工作集时保留最近多少个消息节点。 */
  recentNodes: 12,
  /** 单次压缩最多释放当前上下文的多大比例。 */
  maxFreeRatio: 0.6,
  /** 最近多少步内的相邻请求不重复记录「跳过」原因。 */
  recordSkipWithinSteps: 20,
  /** 观测目录，留空为 ~/.dsh/longsession-care。 */
  telemetryDir: '',
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS))

export const name = 'dsh-longsession/governor'
export const inject = ['compaction', 'tokenMeter']

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(ctx, rawConfig)
  if (cfg.enabled === false) return
  const sessions = new Map()

  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (payload?.step === 1 && Number(payload?.turn) > 1 && payload?.signal?.aborted !== true) {
        await govern(ctx, cfg, sessions, payload)
      }
    } catch {
      /* 治理失败不影响本轮 */
    }
    return next()
  })
}

function normalizeConfig(ctx, rawConfig) {
  const cfg = { ...DEFAULTS }
  if (rawConfig && typeof rawConfig === 'object') {
    for (const [key, value] of Object.entries(rawConfig)) {
      if (!KNOWN_KEYS.has(key)) {
        try {
          ctx.logger?.warn?.(`longsession-governor: 忽略未知配置项 ${key}`)
        } catch {
          /* ignore */
        }
        continue
      }
      cfg[key] = value
    }
  }
  for (const key of ['slack', 'keepFactor', 'minStepsBetween', 'minGrowthRatio', 'recentNodes', 'maxFreeRatio', 'recordSkipWithinSteps']) {
    const numeric = Number(cfg[key])
    cfg[key] = Number.isFinite(numeric) ? numeric : DEFAULTS[key]
  }
  return cfg
}

function sessionState(sessions, session) {
  const id = String(session?.id ?? 'unknown')
  let state = sessions.get(id)
  if (state === undefined) {
    state = { totalSteps: 0, lastCompactStep: -Infinity, lastTotalTokens: 0, lastSkipReason: '', lastSkipStep: -Infinity }
    sessions.set(id, state)
  }
  state.totalSteps += 1
  return state
}

async function govern(ctx, cfg, sessions, payload) {
  const agent = payload.agent
  const session = agent?.session
  if (session === undefined) return
  const state = sessionState(sessions, session)

  const meter = ctx.tokenMeter
  let pressureInfo
  let measurement
  try {
    pressureInfo = meter.contextPressure(session)
    measurement = meter.measure(session)
  } catch {
    return
  }
  if (measurement === undefined || !Array.isArray(measurement.nodes) || measurement.nodes.length < 4) return

  const window = pressureInfo?.contextWindow
  const pressure = pressureInfo?.pressureTokens ?? measurement.totalTokens
  const evaluation = evaluate({
    cfg,
    state,
    nodes: measurement.nodes,
    pressure,
    window,
    totalTokens: measurement.totalTokens,
    surfaceTokens: measurement.surfaceTokens,
  })

  if (evaluation.action !== 'compact') {
    recordSkip(ctx, cfg, state, session, evaluation)
    return
  }

  const before = { ...state }
  const plan = evaluation.plan
  let endIdx = plan.endIdx
  let error
  for (let attempt = 0; attempt < 6 && endIdx >= 2; attempt += 1) {
    const startSeq = measurement.nodes[1].seq
    const endSeq = measurement.nodes[endIdx].seq
    try {
      await ctx.compaction.compactRegion(startSeq, endSeq, agent, payload.signal)
      recordTelemetry(ctx, cfg, session, {
        action: 'compact',
        turn: payload.turn,
        step: payload.step,
        pressure: Math.round(pressure),
        window,
        workingSet: Math.round(evaluation.workingSet),
        regionNodes: endIdx - 1 + 1,
        regionTokens: Math.round(plan.regionTokens),
        freedEstimate: Math.round(plan.regionTokens),
        totalBefore: measurement.totalTokens,
        ok: true,
      })
      state.lastCompactStep = state.totalSteps
      state.lastTotalTokens = Math.max(0, measurement.totalTokens - plan.regionTokens)
      state.lastSkipReason = ''
      return
    } catch (caught) {
      error = caught
      endIdx -= 1
      recordTelemetry(ctx, cfg, session, {
        action: 'compact-retry',
        turn: payload.turn,
        step: payload.step,
        endIdx,
        reason: String(caught?.message ?? caught).slice(0, 240),
      })
    }
  }
  state.lastCompactStep = before.lastCompactStep
  recordTelemetry(ctx, cfg, session, {
    action: 'compact-failed',
    turn: payload.turn,
    step: payload.step,
    reason: String(error?.message ?? error ?? '没有可用的平衡切点').slice(0, 240),
  })
}

/**
 * 纯决策函数，便于单元测试。
 * @returns {{action:'skip', reason:string} | {action:'compact', workingSet:number, plan:{startIdx:number,endIdx:number,regionTokens:number}}}
 */
export function evaluate({ cfg, state, nodes, pressure, window, totalTokens, surfaceTokens }) {
  if (!Number.isFinite(window) || window <= 0) return { action: 'skip', reason: 'no-window' }
  if (!Number.isFinite(pressure) || pressure <= 0) return { action: 'skip', reason: 'no-pressure' }

  const overhead = Math.max(0, (totalTokens ?? 0) - (surfaceTokens ?? 0))
  const recent = sumTail(nodes, cfg.recentNodes)
  const systemTokens = nodes[0]?.tokens ?? 0
  const workingSet = systemTokens + overhead + recent
  if (workingSet <= 0) return { action: 'skip', reason: 'no-working-set' }

  if (pressure > window * 0.9) return { action: 'skip', reason: 'overflow-guard' }
  if (pressure <= workingSet * cfg.slack) return { action: 'skip', reason: 'below-slack' }
  if (state.totalSteps - state.lastCompactStep < cfg.minStepsBetween) return { action: 'skip', reason: 'cooldown' }
  if (state.lastTotalTokens > 0) {
    const growth = (totalTokens ?? pressure) - state.lastTotalTokens
    if (growth < workingSet * cfg.minGrowthRatio) return { action: 'skip', reason: 'growth-too-small' }
  }
  const keepBudget = workingSet * cfg.keepFactor
  const targetFree = pressure - keepBudget
  if (targetFree < workingSet) return { action: 'skip', reason: 'relief-too-small' }

  const maxFree = Math.min(pressure * cfg.maxFreeRatio, window * 0.5)
  const plan = chooseRegion(nodes, keepBudget, maxFree)
  if (plan === null) return { action: 'skip', reason: 'no-balanced-region' }
  return { action: 'compact', workingSet, plan }
}

/** 从尾部保留 keepBudget，向前找最老的可压缩区间；释放量不超过 maxFree。 */
export function chooseRegion(nodes, keepBudget, maxFree) {
  if (!Array.isArray(nodes) || nodes.length < 4) return null
  let kept = 0
  let splitIdx = nodes.length
  for (let index = nodes.length - 1; index >= 1; index -= 1) {
    kept += nodes[index]?.tokens ?? 0
    splitIdx = index
    if (kept >= keepBudget) break
  }
  let endIdx = splitIdx - 1
  if (endIdx < 2) return null
  let regionTokens = 0
  for (let index = 1; index <= endIdx; index += 1) regionTokens += nodes[index]?.tokens ?? 0
  while (regionTokens > maxFree && endIdx > 2) {
    regionTokens -= nodes[endIdx]?.tokens ?? 0
    endIdx -= 1
  }
  if (endIdx < 2 || regionTokens <= 0) return null
  return { startIdx: 1, endIdx, regionTokens }
}

function sumTail(nodes, count) {
  let total = 0
  const from = Math.max(1, nodes.length - Math.max(1, count))
  for (let index = from; index < nodes.length; index += 1) total += nodes[index]?.tokens ?? 0
  return total
}

function recordSkip(ctx, cfg, state, session, evaluation) {
  const reason = evaluation.reason
  if (state.lastSkipReason === reason && state.totalSteps - state.lastSkipStep < cfg.recordSkipWithinSteps) return
  state.lastSkipReason = reason
  state.lastSkipStep = state.totalSteps
  recordTelemetry(ctx, cfg, session, { action: 'skip', reason, totalSteps: state.totalSteps })
}

function recordTelemetry(ctx, cfg, session, record) {
  const dir = resolveTelemetryDir(cfg.telemetryDir)
  if (dir === '') return
  try {
    mkdirSync(dir, { recursive: true })
    const line = { ts: new Date().toISOString(), session: String(session?.id ?? ''), ...record }
    appendFileSync(join(dir, 'governor.jsonl'), JSON.stringify(line) + '\n', 'utf8')
  } catch {
    /* 观测失败不影响会话 */
  }
}

function resolveTelemetryDir(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'longsession-care')
}

export const __test = { DEFAULTS }
