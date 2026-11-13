import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveState, buildCardText, readTodos } from '../index.js'

const CFG = { minSteps: 6, minHumanMessages: 1 }

const event = (type, data) => ({ type, data })
const human = (text) => event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
const injected = (text) => event('user/message', { source: { kind: 'system-reminder' }, content: [{ type: 'text', text }] })
const todoCall = (todos) => event('tool/call', { name: 'todo_write', arguments: JSON.stringify({ todos }) })
const step = () => event('step/start', { turn: 1, step: 1 })

test('清单优先读官方投影真值', () => {
  const states = new Map()
  const session = { id: 's1', log: [step(), human('做 A'), todoCall([{ content: '旧的', status: 'pending' }])] }
  const state = deriveState(session, states)
  const ctx = { get: (key) => (key === 'sessionProjections' ? { snapshot: () => ({ values: { todos: [{ content: '真值', status: 'in_progress' }] } }) } : undefined) }
  const view = readTodos(ctx, session, state)
  assert.equal(view.source, 'live')
  assert.equal(view.todos[0].content, '真值')
})

test('官方清单在新轮次清空时如实标注', () => {
  const states = new Map()
  const session = { id: 's2', log: [step(), human('做 A'), todoCall([{ content: '改按钮', status: 'pending' }])] }
  const state = deriveState(session, states)
  const ctx = { get: (key) => (key === 'sessionProjections' ? { snapshot: () => ({ values: { todos: null } }) } : undefined) }
  const view = readTodos(ctx, session, state)
  assert.equal(view.source, 'cleared')
  const text = buildCardText({ state, todoView: view })
  assert.match(text, /官方清单已在新轮次清空/)
  assert.match(text, /改按钮/)
})

test('投影不可用时退回回放，不崩溃', () => {
  const states = new Map()
  const session = { id: 's3', log: [step(), todoCall([{ content: 'x' }])] }
  const state = deriveState(session, states)
  const ctx = { get: () => { throw new Error('boom') } }
  assert.equal(readTodos(ctx, session, state).source, 'replayed')
})

test('只有编辑/写入才更新关注文件', () => {
  const states = new Map()
  const session = {
    id: 's4',
    log: [
      step(),
      event('tool/call', { name: 'edit', arguments: JSON.stringify({ file_path: 'src/a.ts' }) }),
      event('tool/call', { name: 'read', arguments: JSON.stringify({ file_path: 'docs/b.md' }) }),
    ],
  }
  const state = deriveState(session, states)
  assert.equal(state.focus, 'src/a.ts')
})

test('不做重复计数、忽略注入消息', () => {
  const states = new Map()
  const session = { id: 's5', log: [injected('框架'), human('人类一'), step()] }
  const first = deriveState(session, states)
  assert.equal(first.humanCount, 1)
  assert.equal(first.lastHuman, '人类一')
  session.log.push(step())
  const second = deriveState(session, states)
  assert.equal(second.steps, 2)
  assert.equal(second.humanCount, 1)
})

test('卡片包含目标与未完成项且足够短', () => {
  const state = { steps: 20, humanCount: 1, lastHuman: '把登录页改深色', lastWrittenTodos: [{ content: '改按钮', status: 'pending' }, { content: '补测试', status: 'completed' }], focus: 'src/Login.tsx', compactions: 0 }
  const text = buildCardText({ goal: '深色主题', state, todoView: { source: 'live', todos: state.lastWrittenTodos } })
  assert.match(text, /目标：深色主题/)
  assert.match(text, /未完成（1 项，已完成 1 项）/)
  assert.match(text, /最近编辑的文件：src\/Login\.tsx/)
  assert.ok(text.length < 1200)
})

test('没有事实时不产卡片', () => {
  assert.equal(buildCardText({ state: { steps: 9, humanCount: 0, lastHuman: '', lastWrittenTodos: [], focus: '', compactions: 0 } }), '')
  assert.equal(CFG.minSteps, 6)
})
