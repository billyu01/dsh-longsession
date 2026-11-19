import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, chooseRegion, shouldCheck, findOriginalRequestStart, initializeState } from '../governor.js'

const CFG = {
  slack: 3,
  keepFactor: 1.5,
  minStepsBetween: 60,
  minGrowthRatio: 1,
  maxFreeWorkSets: 2,
  maxFreeRatio: 0.6,
  recentNodes: 12,
  minPressureTokens: 1,
  emergencyRatio: 0.6,
  minFreeTokens: 1,
}

const freshState = (overrides = {}) => ({ totalSteps: 100, lastCompactStep: -Infinity, lastTotalTokens: 0, ...overrides })

function makeNodes({ count = 41, head = 2000, each = 2425 } = {}) {
  const nodes = []
  for (let i = 0; i < count; i += 1) nodes.push({ seq: i + 1, tokens: i === 0 ? head : each })
  return nodes
}

const surfaceOf = (nodes) => nodes.reduce((sum, n) => sum + n.tokens, 0)
const workingSetOf = (nodes) => {
  const surface = surfaceOf(nodes)
  const total = surface + 1000
  const recent = nodes.slice(-12).reduce((sum, n) => sum + n.tokens, 0)
  return nodes[0].tokens + (total - surface) + recent
}

test('没有窗口信息时跳过', () => {
  const result = evaluate({ cfg: CFG, state: freshState(), nodes: makeNodes(), pressure: 100000, window: undefined, totalTokens: 100000, surfaceTokens: 99000 })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'no-window')
})

test('低于工作集倍数时跳过', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const result = evaluate({ cfg: CFG, state: freshState(), nodes, pressure: 60000, window: 200000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'below-slack')
})

test('冷却按真实步数计，不足 60 步跳过', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const result = evaluate({ cfg: CFG, state: freshState({ totalSteps: 100, lastCompactStep: 50 }), nodes, pressure: 150000, window: 200000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'cooldown')
})

test('冷却满足后可以压缩', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const result = evaluate({ cfg: CFG, state: freshState({ totalSteps: 100, lastCompactStep: 40 }), nodes, pressure: 150000, window: 300000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'compact')
})

test('接近溢出时交给官方兜底', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const result = evaluate({ cfg: CFG, state: freshState(), nodes, pressure: 190000, window: 200000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'overflow-guard')
})

test('满足条件时给出增量压缩区间，且不超过工作集两倍', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const workingSet = workingSetOf(nodes)
  const result = evaluate({ cfg: CFG, state: freshState(), nodes, pressure: 160000, window: 300000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'compact')
  assert.equal(result.plan.startIdx, 1)
  assert.ok(result.plan.endIdx >= 2)
  assert.ok(result.plan.regionTokens <= workingSet * 2)
  assert.ok(result.plan.regionTokens > 0)
})

test('压力很大时单次释放仍被工作集上限压住', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const workingSet = workingSetOf(nodes)
  const result = evaluate({ cfg: CFG, state: freshState({ totalSteps: 400 }), nodes, pressure: 450000, window: 1000000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'compact')
  assert.ok(result.plan.regionTokens <= workingSet * 2)
  assert.ok(result.plan.regionTokens <= 450000 * 0.6)
})

test('增长不足时跳过', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const total = surface + 1000
  const result = evaluate({ cfg: CFG, state: freshState({ lastTotalTokens: total - 1000 }), nodes, pressure: total, window: 300000, totalTokens: total, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'growth-too-small')
})

test('区间选择：保留尾部、起点固定为 1、释放量受限', () => {
  const plan = chooseRegion(makeNodes(), 22500, 60000)
  assert.ok(plan !== null)
  assert.equal(plan.startIdx, 1)
  assert.ok(plan.endIdx > 1 && plan.endIdx < 40)
  assert.ok(plan.regionTokens <= 60000)
})

test('无有效切点时返回 null', () => {
  assert.equal(chooseRegion(makeNodes({ count: 4 }), 999999, 60000), null)
  assert.equal(chooseRegion([], 100, 100), null)
})

test('低于绝对压力门槛时跳过', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const cfg = { ...CFG, minPressureTokens: 250000 }
  const result = evaluate({ cfg, state: freshState(), nodes, pressure: 200000, window: 1000000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'below-floor')
})

test('边界判断：轮首、紧急压力、其余时刻', () => {
  assert.equal(shouldCheck({ step: 1, turn: 2, pressure: 100000, window: 1000000, emergencyRatio: 0.6 }), true)
  assert.equal(shouldCheck({ step: 7, turn: 1, pressure: 700000, window: 1000000, emergencyRatio: 0.6 }), true)
  assert.equal(shouldCheck({ step: 7, turn: 3, pressure: 300000, window: 1000000, emergencyRatio: 0.6 }), false)
  assert.equal(shouldCheck({ step: 1, turn: 1, pressure: 100000, window: 1000000, emergencyRatio: 0.6 }), false)
  assert.equal(shouldCheck({ step: 7, turn: 1, pressure: 700000, window: 1000000, emergencyRatio: 0 }), false)
  assert.equal(shouldCheck({ step: 7, turn: 1, pressure: undefined, window: 1000000, emergencyRatio: 0.6 }), false)
})

test('预计释放量低于收益门槛时跳过', () => {
  const nodes = makeNodes()
  const surface = surfaceOf(nodes)
  const cfg = { ...CFG, minFreeTokens: 100000 }
  const result = evaluate({ cfg, state: freshState(), nodes, pressure: 160000, window: 300000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'benefit-too-small')
})

test('原始人类请求之后才开始压缩区间', () => {
  const nodes = [{ seq: 10, tokens: 2000 }, { seq: 11, tokens: 100 }, { seq: 12, tokens: 3000 }, { seq: 13, tokens: 500 }]
  const human = { type: 'user/message', data: { source: { kind: 'user' } } }
  const tool = { type: 'tool/result', data: {} }
  const session = { eventAt: (seq) => (seq === 11 ? human : tool) }
  assert.equal(findOriginalRequestStart(session, nodes), 2)
  assert.equal(findOriginalRequestStart({ eventAt: () => tool }, nodes), 1)
  assert.equal(findOriginalRequestStart({ eventAt: () => { throw new Error('x') } }, nodes), 1)
})

test('初始化时从日志恢复步数与上次压缩位置', () => {
  const log = [
    { type: 'step/start' }, { type: 'step/start' }, { type: 'step/start' },
    { type: 'compaction/start', data: {} }, { type: 'compaction/summary', data: {} },
    { type: 'step/start' }, { type: 'step/start' },
  ]
  const session = { log }
  const state = initializeState({ initialized: false, totalSteps: 0, lastCompactStep: -Infinity, lastAttemptStep: -Infinity, lastTotalTokens: 0 }, session)
  assert.equal(state.totalSteps, 5)
  assert.equal(state.lastCompactStep, 3)
  assert.equal(state.lastAttemptStep, 3)
  assert.equal(initializeState({ initialized: false, totalSteps: 0, lastCompactStep: -Infinity, lastAttemptStep: -Infinity, lastTotalTokens: 0 }, { log: [] }).totalSteps, 0)
})
