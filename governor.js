/**
 * 自适应增量压缩治理（挂在智能体预设的 compaction 隔离组里）。
 *
 * 官方压缩只在窗口用满 80% 时触发，而且一次把最老的一大段历史替换成摘要。
 * 实测 36 次压缩里，中位数一次删掉 49 万 token、只换回 1.3 万字符摘要；
 * 压缩后模型反复重读文件、重跑命令。本插件把压缩改造成：
 *
 * 1. 按「工作集」触发，而不是固定窗口百分比：
 *      工作集 = 系统提示 + 请求固定开销 + 最近 recentNodes 个消息节点；
 *      压力超过工作集的 slack 倍才考虑压缩。
 * 2. 只在轮次边界动手（每轮第一步），避免从步骤中间切走任务状态。
 * 3. 每次只压最老的一段，把上下文压回工作集的 keepFactor 倍就停。
 * 4. 防抖：两次压缩之间至少 minStepsBetween 步，且新增量达到工作集的一定倍数。
 * 5. 官方 80% 阈值保留为安全兜底；接近窗口 90% 时本插件主动让位。
 *
 * 任何异常都只吞掉并放行，绝不打断本轮对话。
 */

const DEFAULTS = {
  enabled: true,
  /** 压力超过工作集的多少倍才考虑压缩。 */
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
  for (const key of ['slack', 'keepFactor', 'minStepsBetween', 'minGrowthRatio', 'recentNodes', 'maxFreeRatio']) {
    const numeric = Number(cfg[key])
    cfg[key] = Number.isFinite(numeric) ? numeric : DEFAULTS[key]
  }
  return cfg
}

function sessionState(sessions, session) {
  const id = String(session?.id ?? 'unknown')
  let state = sessions.get(id)
  if (state === undefined) {
    state = { totalSteps: 0, lastCompactStep: -Infinity, lastTotalTokens: 0 }
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

  let pressureInfo
  let measurement
  try {
    pressureInfo = ctx.tokenMeter.contextPressure(session)
    measurement = ctx.tokenMeter.measure(session)
  } catch {
    return
  }
  if (measurement === undefined || !Array.isArray(measurement.nodes) || measurement.nodes.length < 4) return

  const window = pressureInfo?.contextWindow
  const pressure = pressureInfo?.pressureTokens ?? measurement.totalTokens
  const plan = evaluate({
    cfg,
    state,
    nodes: measurement.nodes,
    pressure,
    window,
    totalTokens: measurement.totalTokens,
    surfaceTokens: measurement.surfaceTokens,
  })
  if (plan === null) return

  let endIdx = plan.endIdx
  for (let attempt = 0; attempt < 6 && endIdx >= 2; attempt += 1) {
    try {
      await ctx.compaction.compactRegion(
        measurement.nodes[1].seq,
        measurement.nodes[endIdx].seq,
        agent,
        payload.signal,
      )
      state.lastCompactStep = state.totalSteps
      state.lastTotalTokens = Math.max(0, measurement.totalTokens - plan.regionTokens)
      return
    } catch {
      endIdx -= 1
    }
  }
}

/**
 * 纯决策函数：返回 null 表示不压缩，否则返回要压缩的尾部索引与预计释放量。
 * @returns {null | {startIdx:number, endIdx:number, regionTokens:number}}
 */
export function evaluate({ cfg, state, nodes, pressure, window, totalTokens, surfaceTokens }) {
  if (!Number.isFinite(window) || window <= 0) return null
  if (!Number.isFinite(pressure) || pressure <= 0) return null

  const overhead = Math.max(0, (totalTokens ?? 0) - (surfaceTokens ?? 0))
  const recent = sumTail(nodes, cfg.recentNodes)
  const systemTokens = nodes[0]?.tokens ?? 0
  const workingSet = systemTokens + overhead + recent
  if (workingSet <= 0) return null

  if (pressure > window * 0.9) return null
  if (pressure <= workingSet * cfg.slack) return null
  if (state.totalSteps - state.lastCompactStep < cfg.minStepsBetween) return null
  if (state.lastTotalTokens > 0) {
    const growth = (totalTokens ?? pressure) - state.lastTotalTokens
    if (growth < workingSet * cfg.minGrowthRatio) return null
  }
  const keepBudget = workingSet * cfg.keepFactor
  const targetFree = pressure - keepBudget
  if (targetFree < workingSet) return null

  const maxFree = Math.min(pressure * cfg.maxFreeRatio, window * 0.5)
  return chooseRegion(nodes, keepBudget, maxFree)
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

export const __test = { DEFAULTS }
