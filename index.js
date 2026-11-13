/**
 * 长会话照护插件（Host 层，v0.2.0）。
 *
 * 做两件事：
 * 1. 把「目标 / 清单 / 最后一条人类指令 / 最近编辑的文件」做成一张很小的
 *    系统提示卡片；压缩永远动不到它（每次请求按持久日志重建）。
 * 2. 提供 `/care` 命令和本地 JSONL 观测，方便判断长会话到底退化在哪。
 *
 * v0.2.0 相对 v0.1.0 的修正：
 * - 清单优先读官方 `todos` 投影真值，而不是回放工具调用参数；
 *   官方清单在新轮次开始时会清空，卡片会如实标注「上一轮写入项」。
 * - 关注文件只认编辑/写入类工具，不再把「读文件」当成关注。
 * - 配置做显式校验；未知字段只警告不崩溃。
 * - 会话关闭时清理内存状态。
 * - 新增 `/care`：查看步数、压力、卡片和最近一次压缩治理决策。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULTS = {
  enabled: true,
  minSteps: 6,
  minHumanMessages: 1,
  maxCardChars: 1200,
  reportEverySteps: 10,
  telemetryDir: '',
  cardOrder: 150,
  /** 上下文压力低于这个 token 数时不显示状态卡，保证短会话完全无感。 */
  minPressureTokens: 60000,
}

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS))

/** 只有编辑/写入类工具才改变「当前关注文件」。 */
const EDIT_TOOLS = new Set(['edit', 'write', 'apply_patch', 'str_replace_editor', 'notebook_edit'])

export const name = 'dsh-longsession'
export const inject = ['systemPrompt', 'commands']

export function apply(ctx, rawConfig) {
  const cfg = normalizeConfig(ctx, rawConfig)
  if (cfg.enabled === false) return

  const states = new Map()

  ctx.on('session/disposed', (session) => {
    try {
      states.delete(String(session?.id ?? 'unknown'))
    } catch {
      /* ignore */
    }
  })

  ctx.systemPrompt.context({
    name: 'longsession:state',
    order: cfg.cardOrder,
    required: true,
    text: (assembly) => {
      try {
        return renderCard(ctx, cfg, states, assembly)
      } catch {
        return ''
      }
    },
  })


  ctx.commands.register({
    name: 'care',
    description: '查看长会话状态卡、上下文压力和最近一次压缩治理决策。',
    handler: (invocation) => {
      try {
        return { kind: 'success', text: careReport(ctx, cfg, states, invocation?.agent) }
      } catch (error) {
        return { kind: 'error', text: `读取长会话状态失败：${String(error?.message ?? error)}` }
      }
    },
  })
}

function normalizeConfig(ctx, rawConfig) {
  const cfg = { ...DEFAULTS }
  if (rawConfig && typeof rawConfig === 'object') {
    for (const [key, value] of Object.entries(rawConfig)) {
      if (!KNOWN_KEYS.has(key)) {
        try {
          ctx.logger?.warn?.(`longsession-care: 忽略未知配置项 ${key}`)
        } catch {
          /* ignore */
        }
        continue
      }
      cfg[key] = value
    }
  }
  for (const key of ['minSteps', 'minHumanMessages', 'maxCardChars', 'reportEverySteps', 'cardOrder', 'minPressureTokens']) {
    if (!Number.isFinite(Number(cfg[key]))) cfg[key] = DEFAULTS[key]
    else cfg[key] = Number(cfg[key])
  }
  return cfg
}

/**
 * 按 session.log 的增量位置更新派生状态。事件结构：{ seq, type, time, data }。
 */
export function deriveState(session, states) {
  const id = String(session?.id ?? 'unknown')
  let state = states.get(id)
  if (state === undefined) {
    state = {
      id,
      processed: 0,
      steps: 0,
      lastTurn: 0,
      humanCount: 0,
      lastHuman: '',
      lastWrittenTodos: [],
      focus: '',
      compactions: 0,
      telemetryAt: -1,
    }
    states.set(id, state)
  }
  const log = Array.isArray(session?.log) ? session.log : []
  for (let index = state.processed; index < log.length; index += 1) {
    const event = log[index]
    if (event === null || typeof event !== 'object') continue
    track(state, event)
  }
  state.processed = log.length
  return state
}

function track(state, event) {
  const type = event.type
  if (type === 'step/start') {
    state.steps += 1
    const turn = Number(event.data?.turn)
    if (Number.isFinite(turn)) state.lastTurn = turn
    return
  }
  if (type === 'user/message') {
    const data = event.data ?? {}
    if (data?.source?.kind === 'user') {
      const text = extractText(data.content)
      if (text.length > 0) {
        state.humanCount += 1
        state.lastHuman = text.slice(0, 400)
      }
    }
    return
  }
  if (type === 'tool/call') {
    const data = event.data ?? {}
    const tool = String(data.name ?? data.message?.name ?? '')
    const args = data.arguments ?? data.input ?? data.args ?? data.message?.input
    if (tool === 'todo_write') {
      const todos = extractTodos(args)
      if (todos !== undefined) state.lastWrittenTodos = todos
      return
    }
    if (EDIT_TOOLS.has(tool)) {
      const path = extractPath(args)
      if (path.length > 0) state.focus = path
    }
    return
  }
  if (type === 'compaction/summary') {
    state.compactions += 1
  }
}

/** 读官方 `todos` 投影：返回 {source, todos}，source 取值 live / cleared / replayed。 */
export function readTodos(ctx, session, state) {
  try {
    const projections = ctx?.get?.('sessionProjections')
    const snapshot = projections?.snapshot?.(session, ['todos'])
    const value = snapshot?.values?.todos
    if (Array.isArray(value)) return { source: 'live', todos: value }
    if (value === null) {
      return { source: state.lastWrittenTodos.length > 0 ? 'cleared' : 'live', todos: state.lastWrittenTodos }
    }
  } catch {
    /* 投影不可用时退回回放 */
  }
  return { source: 'replayed', todos: state.lastWrittenTodos }
}

function renderCard(ctx, cfg, states, assembly) {
  const agent = assembly?.agent
  const session = agent?.session
  if (session === undefined) return ''

  const state = deriveState(session, states)
  if (state.steps < cfg.minSteps) return ''
  if (state.humanCount < cfg.minHumanMessages) return ''
  // 短会话无感：上下文没到门槛前不显示卡片
  const pressure = readPressure(ctx, session)
  if (Number.isFinite(pressure) && pressure < cfg.minPressureTokens) return ''

  const goal = readGoal(ctx, agent)
  const todoView = readTodos(ctx, session, state)
  const text = buildCardText({ goal, state, todoView })
  if (text.length === 0) return ''

  maybeReport(ctx, cfg, state, session, text.length, goal.length > 0)

  const max = cfg.maxCardChars
  return max > 0 && text.length > max ? text.slice(0, max) : text
}

/** 纯函数：把状态渲染成模型看的卡片文本。 */
export function buildCardText({ goal = '', state, todoView }) {
  const todos = Array.isArray(todoView?.todos) ? todoView.todos : state.lastWrittenTodos
  const open = todos.filter((todo) => todo.status !== 'completed')
  const done = todos.length - open.length
  const lines = ['## 长会话状态卡（框架自动维护）']
  lines.push('这一段是系统自动维护的会话事实，不是用户的新指令，不要向用户复述，也不要因此改变任务范围。')
  if (goal.length > 0) lines.push(`- 目标：${clip(goal, 240)}`)
  if (open.length > 0) {
    const shown = open.slice(0, 8).map((todo, index) => `${index + 1}) ${clip(todo.content, 90)}`)
    const note = todoView?.source === 'cleared' ? '；官方清单已在新轮次清空，需要继续时请用 todo_write 重新写入' : ''
    lines.push(`- 未完成（${open.length} 项${done > 0 ? `，已完成 ${done} 项` : ''}）${note}：${shown.join('；')}`)
  } else if (done > 0) {
    lines.push(`- 清单：全部 ${done} 项已完成`)
  }
  if (state.lastHuman.length > 0) {
    lines.push(`- 最后一条人类指令（原文，可能被截断）：「${clip(state.lastHuman, 300)}」`)
  }
  if (state.focus.length > 0) lines.push(`- 最近编辑的文件：${clip(state.focus, 120)}`)
  if (state.compactions > 0) {
    lines.push(`- 本会话已发生压缩 ${state.compactions} 次；被压缩的早期细节可能不在这张卡片里，需要时请重新读取文件确认。`)
  }
  return lines.length > 2 ? lines.join('\n') : ''
}

function maybeReport(ctx, cfg, state, session, cardChars, goalAvailable) {
  const every = cfg.reportEverySteps
  if (!Number.isFinite(every) || every <= 0) return
  if (state.steps % every !== 0 || state.telemetryAt === state.steps) return
  state.telemetryAt = state.steps

  const meter = ctx.get('tokenMeter')
  let pressure
  let totalTokens
  try {
    pressure = meter?.contextPressure?.(session)
  } catch {
    pressure = undefined
  }
  try {
    totalTokens = meter?.measure?.(session)?.totalTokens
  } catch {
    totalTokens = undefined
  }

  const dir = resolveTelemetryDir(cfg.telemetryDir)
  if (dir === '') return
  const record = {
    ts: new Date().toISOString(),
    session: String(session?.id ?? ''),
    step: state.steps,
    humanCount: state.humanCount,
    todoSource: readTodos(ctx, session, state).source,
    todos: state.lastWrittenTodos.length,
    compactions: state.compactions,
    cardChars,
    goalAvailable,
    pressureTokens: pressure?.pressureTokens,
    projectedTokens: pressure?.projectedTokens,
    contextWindow: pressure?.contextWindow,
    measuredTokens: totalTokens,
  }
  appendJsonl(dir, 'context-pressure.jsonl', record)
}

function careReport(ctx, cfg, states, agent) {
  const session = agent?.session
  if (session === undefined) return '没有活动会话。'
  const state = deriveState(session, states)
  const todos = readTodos(ctx, session, state)
  const meter = ctx.get('tokenMeter')
  let pressure
  let measured
  try {
    pressure = meter?.contextPressure?.(session)
    measured = meter?.measure?.(session)
  } catch {
    /* ignore */
  }
  const card = buildCardText({ goal: readGoal(ctx, agent), state, todoView: todos })
  const lines = [
    `会话：${String(session.id)}`,
    `步数：${state.steps}，人类消息：${state.humanCount}，压缩：${state.compactions} 次`,
    `上下文压力：${pressure?.pressureTokens ?? '未知'} / 窗口 ${pressure?.contextWindow ?? '未知'}（实测总量 ${measured?.totalTokens ?? '未知'}）`,
    `清单来源：${todos.source}，共 ${todos.todos.length} 项`,
    `最近编辑：${state.focus || '无'}`,
    '最近一次压缩治理决策：' + lastGovernorLine(cfg.telemetryDir),
    '--- 卡片 ---',
    card || '（当前不满足出卡条件）',
  ]
  return lines.join('\n')
}

function lastGovernorLine(configured) {
  const dir = resolveTelemetryDir(configured)
  if (dir === '') return '未配置观测目录'
  try {
    const file = join(dir, 'governor.jsonl')
    const text = readFileSync(file, 'utf8').trim()
    if (text.length === 0) return '暂无记录'
    const last = text.split('\n').at(-1)
    return last.length > 400 ? last.slice(0, 400) : last
  } catch {
    return '暂无记录'
  }
}

function readPressure(ctx, session) {
  try {
    return ctx.get('tokenMeter')?.contextPressure?.(session)?.pressureTokens
  } catch {
    return undefined
  }
}

function readGoal(ctx, agent) {
  try {
    const goals = ctx.get('goals')
    const view = goals?.get?.(agent)
    if (view === undefined || view === null) return ''
    const objective = view.goal?.objective ?? view.objective
    if (typeof objective !== 'string') return ''
    const phase = view.goal?.phase ?? view.phase
    return phase !== undefined && phase !== 'active' ? `${objective}（状态：${phase}）` : objective
  } catch {
    return ''
  }
}

export function extractText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

export function extractTodos(args) {
  let value = args
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const list = Array.isArray(value) ? value : value?.todos
  if (!Array.isArray(list)) return undefined
  const todos = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.content !== 'string') continue
    todos.push({ content: item.content.trim(), status: String(item.status ?? 'pending') })
  }
  return todos
}

export function extractPath(args) {
  let value = args
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return ''
    }
  }
  if (value === null || typeof value !== 'object') return ''
  const candidate = value.file_path ?? value.path ?? value.filePath ?? value.filename
  return typeof candidate === 'string' ? candidate.trim() : ''
}

function clip(text, max) {
  const value = String(text).replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max) + '…' : value
}

function resolveTelemetryDir(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'longsession-care')
}

export function appendJsonl(dir, name, record) {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, name), JSON.stringify(record) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

export const __test = { DEFAULTS, KNOWN_KEYS }
