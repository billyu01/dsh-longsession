/**
 * 自适应增量压缩治理（挂在智能体预设的 compaction 隔离组里）。
 *
 * 目标：把官方「一次删几十万 token」的压缩，改造成按工作集触发、小步、可防抖、
 * 有收益门槛、有耗时预算的增量压缩。四条约束：
 * 1. 合理策略：按工作集而不是固定窗口比例决定；只在安全边界动手。
 * 2. 成本收益：预计释放量低于 minFreeTokens 不压；单次释放有上限；不新增任何模型调用。
 * 3. 不影响 agent：所有异常吞掉放行；压缩失败/超时都不打断本轮；只走官方事务。
 * 4. 不长时间耗时：每次压缩带 maxLatencyMs 时间预算，超时即放弃；失败后有重试退避。
 */

const DEFAULTS = {
  enabled: true,
  /** 压力超过工作集的多少倍才考虑压缩。 */
  slack: 3,
  /** 压缩后希望上下文回到工作集的多少倍。 */
  keepFactor: 1.5,
  /** 两次压缩之间至少经过多少个模型请求步（按每次请求前计数，不是按轮）。 */
  minStepsBetween: 60,
  /** 距上次压缩的增量至少达到工作集的多少倍才允许再压。 */
  minGrowthRatio: 1,
  /** 单次压缩最多释放「工作集的多少倍」。 */
  maxFreeWorkSets: 2,
  /** 单次压缩最多释放当前上下文的多大比例。 */
  maxFreeRatio: 0.6,
  /** 估算工作集时保留最近多少个消息节点。 */
  recentNodes: 12,
  /** 绝对最低压力门槛：低于这个 token 数一律不压。 */
  minPressureTokens: 250000,
  /** 压力超过窗口这个比例时，允许在一轮中间的步边界压缩。 */
  emergencyRatio: 0.6,
  /** 收益门槛：预计释放量低于这个 token 数就不压（摘要调用不便宜）。 */
  minFreeTokens: 50000,
  /** 单次压缩的时间预算；超时放弃本次，不提交、不阻塞更久。 */
  maxLatencyMs: 15000,
  /** 压缩失败或超时后，至少再过多少步才重试，避免连续卡顿。 */
  retryAfterFailureSteps: 30,
  /** 打开后每次决策写一行 Host 日志（默认关闭，不写文件、不进上下文）。 */
  debug: false,
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
      const session = payload?.agent?.session
      if (session === undefined) return next()
      const state = sessionState(sessions, session)
      if (state.initialized !== true) initializeState(state, session)
      state.totalSteps += 1

      if (payload?.signal?.aborted === true) return next()
      const info = readPressure(ctx, session)
      const pressure = info?.pressureTokens
      const window = info?.contextWindow
      if (!shouldCheck({ step: payload?.step, turn: payload?.turn, pressure, window, emergencyRatio: cfg.emergencyRatio })) return next()
      // 便宜的前置过滤：避免进入昂贵的 measure() 与摘要调用。
      if (Number.isFinite(pressure) && pressure < cfg.minPressureTokens) return next()
      if (state.totalSteps - state.lastCompactStep < cfg.minStepsBetween) return next()
      if (state.totalSteps - state.lastAttemptStep < cfg.retryAfterFailureSteps) return next()
      await govern(ctx, cfg, state, payload)
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
  for (const key of ['slack', 'keepFactor', 'minStepsBetween', 'minGrowthRatio', 'maxFreeWorkSets', 'maxFreeRatio', 'recentNodes', 'minPressureTokens', 'emergencyRatio', 'minFreeTokens', 'maxLatencyMs', 'retryAfterFailureSteps']) {
    const numeric = Number(cfg[key])
    cfg[key] = Number.isFinite(numeric) ? numeric : DEFAULTS[key]
  }
  cfg.debug = cfg.debug === true
  return cfg
}

function sessionState(sessions, session) {
  const id = String(session?.id ?? 'unknown')
  let state = sessions.get(id)
  if (state === undefined) {
    state = {
      initialized: false,
      totalSteps: 0,
      lastCompactStep: -Infinity,
      lastAttemptStep: -Infinity,
      lastTotalTokens: 0,
    }
    sessions.set(id, state)
  }
  return state
}

/** 从会话日志恢复进度：进程重启后冷却不会清零，也不会把已压缩过的会话立刻再压一次。 */
export function initializeState(state, session) {
  state.initialized = true
  const log = Array.isArray(session?.log) ? session.log : []
  let steps = 0
  let stepsAtSummary = null
  let stepsAtStart = null
  for (const event of log) {
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'step/start') steps += 1
    else if (event.type === 'compaction/summary') stepsAtSummary = steps
    else if (event.type === 'compaction/start') stepsAtStart = steps
  }
  state.totalSteps = steps
  if (stepsAtSummary !== null) state.lastCompactStep = stepsAtSummary
  if (stepsAtStart !== null) state.lastAttemptStep = stepsAtStart
  return state
}

async function govern(ctx, cfg, state, payload) {
  const agent = payload.agent
  const session = agent?.session
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
    debug(ctx, cfg, state, session, { action: 'skip', reason: evaluation.reason, pressure, window })
    return
  }

  const plan = evaluation.plan
  // 原始人类请求不进入压缩区间：保留最开头那条需求原文。
  const startIdx = findOriginalRequestStart(session, measurement.nodes)
  if (startIdx >= plan.endIdx) return
  const freedTokens = regionTokensOf(measurement.nodes, startIdx, plan.endIdx)
  if (freedTokens < cfg.minFreeTokens) {
    debug(ctx, cfg, state, session, {
      action: 'skip',
      reason: 'benefit-too-small',
      pressure,
      workingSet: evaluation.workingSet,
      freedTokens,
    })
    return
  }

  let endIdx = plan.endIdx
  let lastError
  for (let attempt = 0; attempt < 6 && endIdx > startIdx; attempt += 1) {
    const result = await attemptCompact(ctx, cfg, payload, measurement, startIdx, endIdx)
    if (result.ok) {
      state.lastCompactStep = state.totalSteps
      state.lastAttemptStep = state.totalSteps
      state.lastTotalTokens = Math.max(0, measurement.totalTokens - freedTokens)
      debug(ctx, cfg, state, session, {
        action: 'compact',
        pressure,
        workingSet: evaluation.workingSet,
        freedTokens,
        startIdx,
        endIdx,
        window,
      })
      return
    }
    lastError = result.error
    if (result.timedOut) break
    endIdx -= 1
  }
  state.lastAttemptStep = state.totalSteps
  debug(ctx, cfg, state, session, {
    action: 'compact-failed',
    pressure,
    workingSet: evaluation.workingSet,
    reason: String(lastError?.message ?? lastError ?? '没有可用的平衡切点').slice(0, 200),
  })
}

/** 用带时间预算的信号调用官方压缩事务；超时/失败都只返回结果，不抛出。 */
async function attemptCompact(ctx, cfg, payload, measurement, startIdx, endIdx) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(1000, cfg.maxLatencyMs))
  const onAbort = () => controller.abort()
  try {
    payload.signal?.addEventListener?.('abort', onAbort, { once: true })
    await ctx.compaction.compactRegion(
      measurement.nodes[startIdx].seq,
      measurement.nodes[endIdx].seq,
      payload.agent,
      controller.signal,
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, timedOut: timedOut || payload.signal?.aborted === true, error }
  } finally {
    clearTimeout(timer)
    payload.signal?.removeEventListener?.('abort', onAbort)
  }
}

function regionTokensOf(nodes, startIdx, endIdx) {
  let total = 0
  for (let index = startIdx; index <= endIdx; index += 1) total += nodes[index]?.tokens ?? 0
  return total
}

function debug(ctx, cfg, state, session, record) {
  if (cfg.debug !== true) return
  try {
    ctx.logger?.info?.(
      `longsession-governor: ${JSON.stringify({
        session: String(session?.id ?? ''),
        step: state.totalSteps,
        ...record,
        pressure: record.pressure === undefined ? undefined : Math.round(record.pressure),
        workingSet: record.workingSet === undefined ? undefined : Math.round(record.workingSet),
      })}`,
    )
  } catch {
    /* 日志失败不影响会话 */
  }
}

function readPressure(ctx, session) {
  try {
    return ctx.tokenMeter?.contextPressure?.(session)
  } catch {
    return undefined
  }
}

/** 找到第一条人类消息在表层里的位置；压缩从它之后开始，原始需求逐字保留。 */
export function findOriginalRequestStart(session, nodes) {
  try {
    for (let index = 1; index < nodes.length; index += 1) {
      const event = session.eventAt?.(nodes[index].seq)
      if (event?.type === 'user/message' && (event.data?.source?.kind) === 'user') return index + 1
    }
  } catch {
    /* 读不到事件时退回默认起点 */
  }
  return 1
}

/**
 * 判断这一刻要不要进入治理检查。
 * 正常只在「第 2 轮起的每轮第一步」检查；当压力超过窗口的 emergencyRatio 时，
 * 允许在一轮中间的任意步边界检查，避免长首轮把上下文推过理想水位。
 */
export function shouldCheck({ step, turn, pressure, window, emergencyRatio }) {
  if (step === 1 && Number(turn) > 1) return true
  if (Number.isFinite(emergencyRatio) && emergencyRatio > 0 && Number.isFinite(window) && window > 0 && Number.isFinite(pressure)) {
    return pressure > window * emergencyRatio
  }
  return false
}

/**
 * 纯决策函数。
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

  if (pressure < cfg.minPressureTokens) return { action: 'skip', reason: 'below-floor' }
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

  const maxFree = Math.max(1, Math.min(workingSet * cfg.maxFreeWorkSets, pressure * cfg.maxFreeRatio, window * 0.5))
  const plan = chooseRegion(nodes, keepBudget, maxFree)
  if (plan === null) return { action: 'skip', reason: 'no-balanced-region' }
  if (plan.regionTokens < cfg.minFreeTokens) return { action: 'skip', reason: 'benefit-too-small' }
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

export const __test = { DEFAULTS }
