import type { AgentMonitorBreakdown, AgentMonitorCache, AgentMonitorRow, AgentMonitorState, AgentMonitorTask } from '../types'
import { truncate } from './describe'
import { formatSpend, formatTokens, formatUsd } from './pricing'
import { bar, countProgress, expectedDurationMs, progressOf } from './progress'

const SHOWN_TASKS = 5
const TASK_BAR_WIDTH = 6
const PROMPT_LINES = 2

/** One drawn line: tree characters, a marker, the text, a dimmed note, an optional bar and a right-aligned status. */
export type TreeLine = {
  prefix: string
  status?: 'running' | 'done' | 'failed'
  text: string
  note: string
  bar: string
  isBold: boolean
  isDim: boolean
  isFooter: boolean
  isPrompt: boolean
  /** The right-aligned status of the header, and the spaces in front of it. */
  right?: string
  rightStatus?: 'running' | 'idle'
  pad: number
  /** Set on the tab bar line: the tabs to draw and the selected one. */
  tabs?: FooterTab[]
  tab?: FooterTab
  /** The coloured rule above the tab bar. */
  isRule?: boolean
  /** A coloured label drawn in front of `text`, such as `Prompt ` on the prompt's first line. */
  lead?: string
  /** Set on the `… N earlier` line: the id of the node whose earlier children it shows or hides. */
  toggles?: string
}

export type FooterTab = 'cost' | 'skills'

export const TAB_LABELS: Record<FooterTab, string> = { cost: 'Cost', skills: 'Skills & rules' }

/** One line under the tab bar saying what the selected tab lists. */
const TAB_DESCRIPTIONS: Record<FooterTab, string> = {
  cost: 'Costs per prompt and per session',
  skills: 'Skills invoked and rules loaded per prompt and per session',
}

/** The tabs in bar order. Skills & rules stays beside Cost even while empty, so it never seems lost. */
const availableTabs = (state: AgentMonitorState): FooterTab[] => {
  const hasLoaded = (state.sessionSkills ?? []).length > 0 || (state.sessionRules ?? []).length > 0
  if (state.sessionUsd !== undefined) return ['cost', 'skills']
  return hasLoaded ? ['skills'] : []
}

/** The rows under the tab bar for the selected tab. */
const tabLines = (state: AgentMonitorState, tab: FooterTab, now: number, expanded: string[]): TreeLine[] => {
  if (tab === 'cost') {
    const sessionUsd = state.sessionUsd ?? 0
    return [
      footerItem('prompt', formatUsd(sessionUsd - (state.promptStartUsd ?? 0))),
      footerItem('session', formatUsd(sessionUsd)),
      ...(state.cache !== undefined ? [footerItem('cache', cacheStatus(state.cache, now))] : []),
      ...topCostLines(state, expanded),
    ]
  }
  const promptSkills = state.promptSkills ?? []
  const sessionSkills = state.sessionSkills ?? []
  const promptRules = state.promptRules ?? []
  const sessionRules = state.sessionRules ?? []
  // One list per scope: the path after each name tells a skill from a rule.
  return loadedLists(
    promptSkills.length + promptRules.length,
    [...skillList(promptSkills, state), ...ruleList(promptRules, state)],
    sessionSkills.length + sessionRules.length,
    [...skillList(sessionSkills, state), ...ruleList(sessionRules, state)],
  )
}

// A clock time, not a countdown: the pane stops redrawing while nothing runs.
const clockTime = (at: number) => new Date(at).toTimeString().slice(0, 5)

/** When main's prompt cache goes cold, as estimated from its last request. */
const cacheStatus = (cache: AgentMonitorCache, now: number): string => {
  const state = cache.expiresAt > now ? `warm until ${clockTime(cache.expiresAt)}` : `cold since ${clockTime(cache.expiresAt)}`
  const ttl = cache.ttlMs >= 60 * 60 * 1000 ? '1h' : `${Math.round(cache.ttlMs / 60_000)}m`
  return `${state} (${ttl} TTL, ${cache.isMeasured ? 'measured' : 'assumed'})`
}

/** The session's most expensive prompts and subagents, priciest first; a pressed one opens what it consists of. */
const topCostLines = (state: AgentMonitorState, expanded: string[]): TreeLine[] => {
  const top = state.topCosts ?? []
  if (top.length === 0) return []
  return [
    line({ isFooter: true }),
    line({ isFooter: true, text: `  Top ${top.length} most expensive in the session` }),
    ...top.flatMap((c, i) => {
      const entry = `  ${String(i + 1).padStart(2)}. ${formatSpend(c).padStart(7)}`
      if (!c.breakdown) return [line({ isFooter: true, text: `${entry}  ${c.label}` })]
      const id = `cost:${c.key}`
      const isOpen = expanded.includes(id)
      const head = line({ isFooter: true, text: `${entry} ${isOpen ? '▾' : '▸'} ${c.label}`, toggles: id })
      return isOpen ? [head, ...breakdownLines(c.breakdown)] : [head]
    }),
  ]
}

const BREAKDOWN_INDENT = ' '.repeat(14)

/** What one entry of the top list consists of: per kind of token, then its priciest requests. */
const breakdownLines = (b: AgentMonitorBreakdown): TreeLine[] => {
  const part = (name: string, p: { usd: number; tokens: number }) =>
    line({ isFooter: true, text: `${BREAKDOWN_INDENT}${name.padEnd(12)}${formatUsd(p.usd).padStart(6)}  ${formatTokens(p.tokens)}` })
  return [
    line({ isFooter: true, isDim: true, text: `${BREAKDOWN_INDENT}${b.steps} ${b.steps === 1 ? 'request' : 'requests'}` }),
    part('cache write', b.cacheWrite),
    part('cache read', b.cacheRead),
    part('output', b.output),
    part('input', b.input),
    line({ isFooter: true, isDim: true, text: `${BREAKDOWN_INDENT}priciest requests` }),
    ...b.top.map(s => line({ isFooter: true, text: `${BREAKDOWN_INDENT}  ${formatUsd(s.usd).padStart(6)}  ${s.label}` })),
  ]
}

const sameItems = (a: ListItem[], b: ListItem[]) =>
  a.length === b.length && a.every((item, i) => item.name === b[i]?.name)

/** The prompt and session lists; one `prompt & session` list when both are the same. */
const loadedLists = (promptTotal: number, prompt: ListItem[], sessionTotal: number, session: ListItem[]): TreeLine[] =>
  sameItems(prompt, session)
    ? footerList('prompt & session', sessionTotal, session)
    : [...footerList('prompt', promptTotal, prompt), ...footerList('session', sessionTotal, session)]

type TreeContext = { state: AgentMonitorState; now: number; columns: number; expectedMs: number; expanded: string[] }

const line = (over: Partial<TreeLine>): TreeLine => ({
  prefix: '',
  text: '',
  note: '',
  bar: '',
  isBold: false,
  isDim: false,
  isFooter: false,
  isPrompt: false,
  pad: 0,
  ...over,
})

/** `42s`, `3m 05s` or `1h 02m`. */
export const formatDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** How long a loop has run so far, or ran; undefined before it started. */
const durationOf = (row: AgentMonitorRow, now: number): string | undefined => {
  if (row.startedAt === 0) return undefined
  const end = row.status === 'running' || row.endedAt === undefined ? now : row.endedAt
  return formatDuration(end - row.startedAt)
}

const modelAndEffort = (row: AgentMonitorRow, now: number) => {
  const spend = formatSpend(row)
  const took = durationOf(row, now)
  return `${row.model ?? '?'} · ${row.effort === undefined ? 'default' : row.effort}${spend ? ` · ${spend}` : ''}${took ? ` · ${took}` : ''}`
}

type Child = { task: AgentMonitorTask; agent?: undefined } | { task?: undefined; agent: AgentMonitorRow }

/** A node's own tasks and the subagents it spawned, in the order they happened. */
const childrenOf = (row: AgentMonitorRow, state: AgentMonitorState): Child[] => {
  const ids = new Set(state.agents.map(a => a.id))
  const spawned = state.agents.filter(a =>
    row.id === 'main' ? !a.parentId || !ids.has(a.parentId) : a.parentId === row.id,
  )
  const kids: Child[] = [
    ...row.tasks.map(task => ({ task })),
    ...spawned.map(agent => ({ agent })),
  ]
  return kids.sort((a, b) => (a.task?.seq ?? a.agent?.seq ?? 0) - (b.task?.seq ?? b.agent?.seq ?? 0))
}

/** The lines of a node's children: the last few, with a count of the earlier ones, or all of them once expanded. */
const childLines = (row: AgentMonitorRow, rest: string, ctx: TreeContext): TreeLine[] => {
  const all = childrenOf(row, ctx.state)
  const earlier = Math.max(0, all.length - SHOWN_TASKS)
  const isExpanded = ctx.expanded.includes(row.id)
  const shown = isExpanded ? all : all.slice(-SHOWN_TASKS)
  const lines: TreeLine[] = []
  if (earlier > 0) {
    const text = isExpanded ? `▾ hide ${earlier} earlier` : `… ${earlier} earlier ▸`
    lines.push(line({ prefix: `${rest}   `, text, isDim: true, toggles: row.id }))
  }
  shown.forEach((kid, index) => {
    const isLast = index === shown.length - 1
    const prefix = rest + (isLast ? '└─ ' : '├─ ')
    const below = rest + (isLast ? '   ' : '│  ')
    if (kid.agent) {
      const agent = kid.agent
      lines.push(
        line({
          prefix,
          status: agent.status === 'idle' ? 'running' : agent.status,
          text: agent.description,
          note: modelAndEffort(agent, ctx.now),
          isBold: agent.status === 'running',
          isDim: agent.status === 'done',
        }),
      )
      const own = childLines(agent, below, ctx)
      // The estimate rides on the subagent's current task, the last line when it runs.
      const current = own[own.length - 1]
      if (agent.status === 'running' && current?.status === 'running') {
        const progress = progressOf(agent, ctx.expectedMs, ctx.now)
        current.bar = `${bar(progress, TASK_BAR_WIDTH)} ~${Math.round(progress * 100)}%`
      }
      lines.push(...own)
    } else {
      const task = kid.task
      lines.push(
        task.isText
          ? line({ prefix, text: `» ${task.label}`, isDim: true })
          : line({ prefix, status: task.status, text: task.label, isBold: task.status === 'running', isDim: task.status === 'done' }),
      )
    }
  })
  return lines
}

const PROMPT_LEAD = 'Prompt '

/** The prompt as `Prompt "…"` on at most two bold lines; cut with `…"` when longer. */
const promptLines = (prompt: string, columns: number, queued: string[] = []): TreeLine[] => {
  if (prompt === '') return []
  const room = Math.max(3, columns)
  const full = `${PROMPT_LEAD}"${prompt}"`
  const isCut = full.length > room * PROMPT_LINES
  const lines = Array.from({ length: PROMPT_LINES }, (_, i) => full.slice(i * room, (i + 1) * room))
    .filter(chunk => chunk !== '')
    .map((chunk, i, all) =>
      {
        const text = isCut && i === all.length - 1 ? `${chunk.slice(0, room - 2)}…"` : chunk
        return i === 0
          ? line({ lead: PROMPT_LEAD, text: text.slice(PROMPT_LEAD.length), isBold: true, isPrompt: true })
          : line({ text, isBold: true, isPrompt: true })
      },
    )
  const queuedLine = queued.map(text => line({ text: truncate(`Queued: "${text}"`, columns), isDim: true, isPrompt: true }))
  // An empty line sets the prompt apart from the Main header.
  return [...lines, ...queuedLine, line({ isPrompt: true })]
}

/** The whole pane: Main with its tree, then the subagent count (hidden when none). */
export const buildTree = (
  state: AgentMonitorState,
  options: { now: number; columns: number; tab?: FooterTab; expanded?: string[] },
): TreeLine[] => {
  const ctx = { state, ...options, expanded: options.expanded ?? [], expectedMs: expectedDurationMs(state.agents) }
  const isBusy = state.main.status === 'running'
  const header = line({
    status: isBusy ? 'running' : 'done',
    text: 'Main',
    note: modelAndEffort(state.main, options.now),
    isBold: true,
  })
  const lines = [...promptLines(state.prompt, options.columns, state.queuedPrompts), header, ...childLines(state.main, '', ctx)]

  const progress = countProgress(state.main, state.agents)
  if (progress.total > 0) lines.push(line({ isFooter: true }))
  if (progress.total > 0) {
    const running = progress.runningAgents
    const agentsNote = running > 0 ? ` (${running} ${running === 1 ? 'subagent' : 'subagents'})` : ''
    const isWorking = isBusy || running > 0
    lines.push(line({ isFooter: true, text: 'Progress', isBold: true }))
    lines.push(footerItem('tasks', `${progress.done}/${progress.total} done`))
    lines.push(footerItem('status', isWorking ? `working${agentsNote}` : 'finished'))
  }
  const tabs = availableTabs(state)
  if (tabs.length > 0) {
    const tab = options.tab !== undefined && tabs.includes(options.tab) ? options.tab : (tabs[0] ?? 'cost')
    lines.push(line({ isFooter: true }))
    lines.push(line({ isFooter: true, text: '─'.repeat(options.columns), isRule: true }))
    lines.push(line({ isFooter: true, tabs, tab }))
    lines.push(line({ isFooter: true }))
    lines.push(line({ isFooter: true, text: TAB_DESCRIPTIONS[tab], isDim: true }))
    lines.push(...tabLines(state, tab, options.now, ctx.expanded))
  }
  const hint = contextHint(state.contextPercent)
  if (hint !== undefined) {
    lines.push(line({ isFooter: true }))
    lines.push(line({ isFooter: true, text: hint, isBold: true }))
  }
  return lines
}

/** Past these shares of the context window, a fresh or compacted context is worth suggesting. */
const COMPACT_AT_PERCENT = 80
const CLEAR_AT_PERCENT = 50

/**
 * A nudge about the context window: every turn re-reads the whole context, so a full
 * one makes each turn slower and costlier. Nothing below half full.
 */
export const contextHint = (percent: number | undefined): string | undefined => {
  if (percent === undefined || percent < CLEAR_AT_PERCENT) return undefined
  if (percent >= COMPACT_AT_PERCENT) return `Hint: context ${percent}% full, run /compact now`
  return `Hint: context ${percent}% full, /clear before an unrelated task`
}

const width = (l: TreeLine) => l.prefix.length + (l.status ? 2 : 0) + l.text.length + (l.note ? l.note.length + 2 : 0) + (l.bar ? l.bar.length + 2 : 0)

/** Keeps the header, the footer and as many of the newest lines as fit; cuts every line to the pane width. */
export const fitLines = (lines: TreeLine[], rows: number, columns: number): TreeLine[] => {
  const top = lines.filter(l => l.isPrompt)
  const header = lines[top.length]
  const footer = lines.filter(l => l.isFooter)
  const body = lines.slice(top.length + 1, lines.length - footer.length)
  const room = Math.max(1, rows - top.length - 1 - footer.length)
  const kept = [...top, header, ...body.slice(-room), ...footer].filter(l => l !== undefined)
  return kept.map(l => {
    if (l.right !== undefined) {
      const right = l.right.length
      const marker = l.status ? 2 : 0
      const note = truncate(l.note, Math.max(0, columns - marker - l.text.length - right - 3))
      const left = marker + l.text.length + (note ? note.length + 2 : 0)
      return { ...l, note, pad: Math.max(1, columns - left - right) }
    }
    if (l.tabs !== undefined) return l
    if (l.isFooter && l.note !== '') {
      return { ...l, note: truncate(l.note, Math.max(0, columns - l.text.length - 2)) }
    }
    const fixed = width(l) - l.text.length
    return { ...l, text: truncate(l.text, Math.max(4, columns - fixed)) }
  })
}

/** A list entry: the name, and where it lives, drawn dim after it. */
type ListItem = { name: string; path?: string }

/** A path relative to the session's folder; `~` for the home folder, `built-in` for a skill shipped with Claude Code. */
export const displayPath = (path: string, cwd: string | undefined): string => {
  if (path.includes('/bundled-skills/')) return 'built-in'
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  const home = path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
  if (home.startsWith('~/.claude/')) return home
  // Without the session's folder (a mod reloaded mid-session never sees session.start),
  // a project's own .claude folder still reads relative to it.
  const project = path.lastIndexOf('/.claude/')
  return project === -1 ? home : path.slice(project + 1)
}

/** A plugin skill is named `plugin:skill`, its folder by the skill alone. */
const pathOf = (paths: Record<string, string> | undefined, name: string, cwd: string | undefined) => {
  const path = paths?.[name] ?? paths?.[name.split(':').pop() ?? name]
  return path === undefined ? undefined : displayPath(path, cwd)
}

/** Skill names in first-use order, with a count when used more than once: `a (2)`, `b`. */
const skillList = (skills: string[], state: AgentMonitorState): ListItem[] => {
  const counts = new Map<string, number>()
  for (const skill of skills) counts.set(skill, (counts.get(skill) ?? 0) + 1)
  return [...counts].map(([name, n]) => ({
    name: n > 1 ? `${name} (${n})` : name,
    path: pathOf(state.skillPaths, name, state.cwd),
  }))
}

const ruleList = (rules: string[], state: AgentMonitorState): ListItem[] =>
  rules.map(name => ({ name, path: pathOf(state.rulePaths, name, state.cwd) }))

/** One indented `label  value` row under a footer header, labels aligned. */
const footerItem = (label: string, value: string): TreeLine =>
  line({ isFooter: true, text: `  ${label.padEnd(8)} ${value}` })

/** A label with its total, `label (n)`, and its items as a bulleted list below it. */
const footerList = (label: string, total: number, items: ListItem[]): TreeLine[] => [
  line({ isFooter: true, text: `  ${label} (${total})` }),
  ...items.map(item => line({ isFooter: true, text: `    • ${item.name}`, note: item.path ?? '' })),
]
