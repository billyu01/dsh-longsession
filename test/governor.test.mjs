import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, chooseRegion } from '../governor.js'

const CFG = {
  slack: 3,
  keepFactor: 1.5,
  minStepsBetween: 25,
  minGrowthRatio: 1,
  recentNodes: 12,
  maxFreeRatio: 0.6,
  recordSkipWithinSteps: 20,
}

const freshState = (overrides = {}) => ({ totalSteps: 100, lastCompactStep: -Infinity, lastTotalTokens: 0, ...overrides })

function makeNodes({ count = 41, head = 2000, each = 2425 } = {}) {
  const nodes = []
  for (let i = 0; i < count; i += 1) nodes.push({ seq: i + 1, tokens: i === 0 ? head : each })
  return nodes
}

test('没有窗口信息时不行动', () => {
  const result = evaluate({ cfg: CFG, state: freshState(), nodes: makeNodes(), pressure: 100000, window: undefined, totalTokens: 100000, surfaceTokens: 99000 })
  assert.deepEqual(result, { action: 'skip', reason: 'no-window' })
})

test('低于工作集倍数时不行动', () => {
  // 工作集 = 2000 系统 + 1000 开销 + 最近 12 个节点 29100 = 32100；压力 60000 不到 3 倍
  const nodes = makeNodes()
  const surface = nodes.reduce((sum, n) => sum + n.tokens, 0)
  const result = evaluate({ cfg: CFG, state: freshState(), nodes, pressure: 60000, window: 200000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'below-slack')
})

test('冷却期内不行动', () => {
  const nodes = makeNodes()
  const surface = nodes.reduce((sum, n) => sum + n.tokens, 0)
  const result = evaluate({ cfg: CFG, state: freshState({ lastCompactStep: 90 }), nodes, pressure: 150000, window: 200000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'cooldown')
})

test('接近溢出时交给官方兜底', () => {
  const nodes = makeNodes()
  const surface = nodes.reduce((sum, n) => sum + n.tokens, 0)
  const result = evaluate({ cfg: CFG, state: freshState(), nodes, pressure: 190000, window: 200000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'overflow-guard')
})

test('满足条件时给出增量压缩方案', () => {
  const nodes = makeNodes()
  const surface = nodes.reduce((sum, n) => sum + n.tokens, 0)
  const result = evaluate({ cfg: CFG, state: freshState(), nodes, pressure: 160000, window: 300000, totalTokens: surface + 1000, surfaceTokens: surface })
  assert.equal(result.action, 'compact')
  assert.ok(result.plan.endIdx >= 2)
  assert.equal(result.plan.startIdx, 1)
  assert.ok(result.plan.regionTokens <= 160000 * 0.6 + 1)
  assert.ok(result.plan.regionTokens > 0)
})

test('增长不足时不行动', () => {
  const nodes = makeNodes()
  const surface = nodes.reduce((sum, n) => sum + n.tokens, 0)
  const total = surface + 1000
  const result = evaluate({ cfg: CFG, state: freshState({ lastTotalTokens: total - 1000 }), nodes, pressure: total, window: 300000, totalTokens: total, surfaceTokens: surface })
  assert.equal(result.action, 'skip')
  assert.equal(result.reason, 'growth-too-small')
})

test('region 选择：保留尾部、起点固定为 1、释放量受限', () => {
  const nodes = makeNodes()
  const plan = chooseRegion(nodes, 22500, 60000)
  assert.ok(plan !== null)
  assert.equal(plan.startIdx, 1)
  assert.ok(plan.endIdx > 1 && plan.endIdx < nodes.length - 1)
  assert.ok(plan.regionTokens <= 60000)
})

test('region 无有效切点时返回 null', () => {
  assert.equal(chooseRegion(makeNodes({ count: 4 }), 999999, 60000), null)
  assert.equal(chooseRegion([], 100, 100), null)
})


