/**
 * 自适应增量压缩治理（挂在智能体预设的 compaction 隔离组里）。
 *
 * 官方压缩只在窗口用满 80% 时触发，而且一次把最老的一大段历史替换成摘要。
 * 实测 36 次压缩里，中位数一次删掉 49 万 token、只换回 1.3 万字符摘要。
 * 本插件把压缩改造成：
 *
 * 1. 按「工作集」触发，而不是固定窗口百分比：
 *      工作集 = 系统提示 + 请求固定开销 + 最近 recentNodes 个消息节点；
 *      压力超过工作集的 slack 倍才考虑压缩。
 * 2. 只在轮次边界动手（每轮第一步），避免从步骤中间切走任务状态。
 * 3. 每次只压最老的一段，且单次释放量有绝对上限：
 *      不超过 工作集 × maxFreeWorkSets（默认 2 倍）；
 *      同时不超过 压力 × maxFreeRatio 与 窗口 × 0.5。
 * 4. 防抖按真实请求步数计：两次压缩之间至少 minStepsBetween 步（默认 60）。
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
  /** 两次压缩之间至少经过多少个模型请求步（按每次请求前计数，不是按轮）。 */
  minStepsBetween: 60,
  /** 距上次压缩的增量至少达到工作集的多少倍才允许再压。 */
  minGrowthRatio: 1,
  /** 单次压缩最多释放「工作集的多少倍」。 */
  maxFreeWorkSets: 2,
  /** 单次压缩最多释放当前上下文的多大比例。 */
  maxFreeRatio: 0.6,
  /** 绝对最低压力门槛：低于这个 token 数一律不压，避免小会话被无谓压缩。 */
  minPressureTokens: 250000,
  /** 压力超过窗口这个比例时，允许在一轮中间的步边界压缩（解决长首轮问题）。 */
  emergencyRatio: 0.6,
  /** 估算工作集时保留最近多少个消息节点。 */
  recentNodes: 12,
  /** 打开后每个决策写一行 Host 日志（默认关闭，不写文件、不进上下文）。 */
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
      // 每次请求前都计数，冷却单位因此是真实步数而不是轮次。
      const state = sessionState(sessions, session)
      if (payload?.signal?.aborted === true) return next()
      const info = readPressure(ctx, session)
      const pressure = info?.pressureTokens
      const window = info?.contextWindow
      const check = shouldCheck({
        step: payload?.step,
        turn: payload?.turn,
        pressure,
        window,
        emergencyRatio: cfg.emergencyRatio,
      })
      if (!check) return next()
      // 便宜的前置过滤：低于绝对门槛或还在冷却期，不进入昂贵的 measure()。
      if (Number.isFinite(pressure) && pressure < cfg.minPressureTokens) return next()
      if (state.totalSteps - state.lastCompactStep < cfg.minStepsBetween) return next()
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
  for (const key of ['slack', 'keepFactor', 'minStepsBetween', 'minGrowthRatio', 'maxFreeWorkSets', 'maxFreeRatio', 'recentNodes', 'minPressureTokens', 'emergencyRatio']) {
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
    state = { totalSteps: 0, lastCompactStep: -Infinity, lastTotalTokens: 0 }
    sessions.set(id, state)
  }
  state.totalSteps += 1
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
  let endIdx = plan.endIdx
  let lastError
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
      debug(ctx, cfg, state, session, {
        action: 'compact',
        pressure,
        workingSet: evaluation.workingSet,
        regionTokens: plan.regionTokens,
        regionNodes: plan.endIdx,
        window,
      })
      return
    } catch (caught) {
      lastError = caught
      endIdx -= 1
    }
  }
  debug(ctx, cfg, state, session, {
    action: 'compact-failed',
    pressure,
    workingSet: evaluation.workingSet,
    reason: String(lastError?.message ?? lastError ?? '没有可用的平衡切点').slice(0, 200),
  })
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

/**
 * 判断这一刻要不要进入治理检查。
 * 正常只在「第 2 轮起的每轮第一步」检查；当压力超过窗口的 emergencyRatio 时，
 * 允许在一轮中间的任意步边界检查，避免长首轮把上下文推过理想水位。
 * @returns 是否检查
 */
export function shouldCheck({ step, turn, pressure, window, emergencyRatio }) {
  if (step === 1 && Number(turn) > 1) return true
  if (Number.isFinite(emergencyRatio) && emergencyRatio > 0 && Number.isFinite(window) && window > 0 && Number.isFinite(pressure)) {
    return pressure > window * emergencyRatio
  }
  return false
}

function readPressure(ctx, session) {
  try {
    return ctx.tokenMeter?.contextPressure?.(session)
  } catch {
    return undefined
  }
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

  // 绝对上限：单次最多释放 工作集 × maxFreeWorkSets，避免再次出现「一次删几十万」。
  const maxFree = Math.max(1, Math.min(workingSet * cfg.maxFreeWorkSets, pressure * cfg.maxFreeRatio, window * 0.5))
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

export const __test = { DEFAULTS }
