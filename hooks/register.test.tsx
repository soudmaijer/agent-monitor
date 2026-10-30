import { expect, test } from 'claude-code/testing'

import type { AgentMonitorRow, AgentMonitorState } from '../types'
import { formatSpend, formatTokens, formatUsd, rankCost, type StepUsage } from './pricing'
import { describeTool, summarizeCommand } from './describe'
import { loadedByTool, rulesInText, skillsInText, textOf } from './loaded'
import { buildTree, contextHint, displayPath, fitLines, formatDuration } from './tree'
import { promoteQueued, viewOf, withPrompt } from './prompt'
import { bar, countAgents, expectedDurationMs, progressOf } from './progress'

const PANE = {
  plugin: 'agent-monitor',
  component: 'Pane',
  requestId: 'agent-monitor',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const spawnInput = (id: string, description: string, parentAgentId?: string) =>
  ({
    tool_use_id: id,
    prompt: 'p',
    description,
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    model: 'haiku',
    parentModel: 'claude-opus',
    background: false,
    fork: false,
    parentAgentId,
  }) as const

/** Stands for the engine beneath the plugin. */
type World = {
  usage?: StepUsage
  sessionUsd?: number
  toolUses?: { name: string; input: Record<string, unknown> }[]
  /** The text the model writes in a step. */
  said?: string
  /** The option the person picks when asked, and the questions asked so far. */
  answer?: string
  asked?: string[]
  /** How many model requests went out. */
  sent?: number
}

const engine = (on: (...args: never[]) => unknown, clock: { now: number }, world: World = {}) => {
  const hook = on as (event: string, fn: (...args: never[]) => unknown) => void
  hook('command.register', () => ({ value: { command: 'agent-monitor' } }))
  hook('ui.open', () => ({ value: { isPlaced: true } }))
  hook('session.start', ((_: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  hook('agent.spawn', ((_: unknown, e: { tool_use_id: string }) => ({ model: 'claude-haiku', agentId: `id-${e.tool_use_id}` })) as never)
  // A Write is refused.
  hook('tool.call', (async (_: unknown, e: { tool: string; questions?: { question: string }[] }) => {
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions?.[0]?.question ?? ''
      world.asked = [...(world.asked ?? []), question]
      return { result: { questions: e.questions, answers: { [question]: world.answer ?? '' } } }
    }
    return e.tool === 'Write' ? { deny: 'no' } : { result: {} }
  }) as never)
  hook('turn.step', (async function* (_: unknown, e: { turnId: string; index: number }) {
    world.sent = (world.sent ?? 0) + 1
    return { turnId: e.turnId, index: e.index, answer: world.said ?? '', toolUses: world.toolUses ?? [], usage: world.usage ?? null }
  }) as never)
  hook('session.usage', () => ({ value: world.sessionUsd === undefined ? {} : { cost: { usd: world.sessionUsd } } }))
  hook('agent.list', () => ({
    value: [{ id: 'id-resumed', description: 'Resumed helper', type: 'Explore', status: 'running' }],
  }))
  hook('clock.every', () => ({ value: undefined }))
  hook('clock.now', () => ({ value: clock.now }))
  hook('turn.complete', () => ({ text: '' }))
  hook('command.run', () => ({ text: '' }))
  hook('prompt.submit', ((_: unknown, e: { text: string }) => ({ text: e.text })) as never)
}

type Mounted = { findAll: (q: { type: string }) => Promise<{ text?: string }[]> }

/** The pane as text: one string per row of the tree. */
const RULE = '─'.repeat(80)
const rowsOf = async (ui: Mounted) => (await ui.findAll({ type: 'Box' })).slice(1).map(b => b.text ?? '')

/** The arrows row above the tree, which shows once there is an earlier prompt. */
const isNavRow = (text: string) => text.startsWith(' ‹ Prev ')

/** The tree's rows alone, without the arrows row and the empty line under it. */
const frame = async (ui: Mounted) => {
  const rows = await rowsOf(ui)
  return isNavRow(rows[0] ?? '') ? rows.slice(2) : rows
}

test('the tree nests a subagent under its spawner, with ✓, ✗ and the footer', async ($, on) => {
  const clock = { now: 1000 }
  engine(on as never, clock)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't0', index: 0, model: 'opus-5.5', effort: 'high', messageCount: 1 } as never)) {
    // drain
  }
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await $.tool.call({ tool: 'Write', file_path: '/x/out.txt', content: '' })
  await $.agent.spawn(spawnInput('one', 'Outer'))
  await $.tool.call({ tool: 'Read', file_path: '/a/notes.md', agentId: 'id-one' })
  await $.agent.spawn(spawnInput('two', 'Inner', 'id-one'))
  await $.tool.call({ tool: 'Read', file_path: '/a/old.md', agentId: 'id-two' })
  await $.turn.complete({ turnId: 't', agentId: 'id-two', answer: '', reason: 'answer' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
    expect(await text(/^Main$/)).toBe('Main')
    expect(await text(/^✓ /)).toBe('✓ ')
    expect(await text(/^✗ /)).toBe('✗ ')
    expect(await text(/^● /)).toBe('● ')
    expect(await text(/^├─ $/)).toBe('├─ ')
    expect(await text(/^   └─ $/)).toBe('   └─ ')
    expect(await text(/^      └─ $/)).toBe('      └─ ')
    expect(await text(/^  tasks/)).toBe('  tasks    5/6 done')
    expect(await text(/^  status/)).toBe('  status   working (1 subagent)')
    // Nothing is mid-call here, so no estimate bar shows.
    expect(await text(/~\d+%/)).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await frame(ui)).toEqual([
    `✓ Main  opus-5.5 · high`,
    '├─ ✓ List files',
    '├─ ✗ Write out.txt',
    '└─ ● Outer  claude-haiku · default · 0s',
    '   ├─ ✓ Read notes.md',
    '   └─ ✓ Inner  claude-haiku · default · 0s',
    '      └─ ✓ Read old.md',
    ' ',
    'Progress',
    '  tasks    5/6 done',
    '  status   working (1 subagent)',
  ])
  await ui.unmount()
})

test('a running subagent shows the estimate on its running task only, and cuts early tasks', () => {
  const task = (id: string, status: 'running' | 'done', seq: number) => ({ id, label: `Step ${id}`, status, seq })
  const state = {
    prompt: '',
    main: row({ id: 'main', status: 'running', model: 'opus-5.5', effort: 'high', tasks: [task('m1', 'done', 1)] }),
    seq: 20,
    agents: [
      row({
        id: 'a',
        description: 'Builder',
        model: 'sonnet',
        effort: 'low',
        seq: 2,
        startedAt: 0,
        tasks: [1, 2, 3, 4, 5, 6, 7].map(n => task(`t${n}`, n === 7 ? 'running' : 'done', 2 + n)),
      }),
      row({ id: 'b', description: 'Done one', status: 'done', seq: 3, startedAt: 0, endedAt: 60_000 }),
    ],
  }
  const lines = fitLines(buildTree(state, { now: 30_000, columns: 60 }), 30, 60)
  const text = (l: (typeof lines)[number]) =>
    `${l.prefix}${l.status === 'done' ? '✓ ' : l.status === 'failed' ? '✗ ' : l.status === 'running' ? '● ' : ''}${l.text}` +
    `${l.note ? `  ${l.note}` : ''}${l.bar ? `  ${l.bar}` : ''}${l.right ? `${' '.repeat(l.pad)}${l.right}` : ''}`
  const rows = lines.map(text)
  expect(rows).toEqual([
    `● Main  opus-5.5 · high`,
    '├─ ✓ Step m1',
    '├─ ● Builder  sonnet · low',
    '│     … 2 earlier ▸',
    '│  ├─ ✓ Step t3',
    '│  ├─ ✓ Step t4',
    '│  ├─ ✓ Step t5',
    '│  ├─ ✓ Step t6',
    `│  └─ ● Step t7  ${bar(0.5, 6)} ~50%`,
    '└─ ✓ Done one  ? · default',
    '',
    'Progress',
    '  tasks    8/10 done',
    '  status   working (1 subagent)',
  ])
})

test('pressing the earlier line shows all of a node\'s tasks, and pressing it again hides them', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const n of [1, 2, 3, 4, 5, 6, 7]) await $.tool.call({ tool: 'Read', file_path: `/a/f${n}.md` })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^… 2 earlier ▸$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read f1\.md/ })).toBeUndefined()

  await ui.press({ key: 'toggle-main' })
  expect(await ui.find({ type: 'Text', text: /^▾ hide 2 earlier$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read f1\.md/ })).toBeDefined()

  await ui.press({ key: 'toggle-main' })
  expect(await ui.find({ type: 'Text', text: /Read f1\.md/ })).toBeUndefined()
  await ui.unmount()
})

test('the text the model writes shows before the tool calls of its step, on one line, and is not counted as a task', async ($, on) => {
  const world: World = { said: 'First I look\n\nat the tree.' }
  engine(on as never, { now: 1000 }, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await priced($ as never)
  await $.tool.call({ tool: 'Read', file_path: '/a/tree.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await rowsOf(ui)
  const said = rows.findIndex(r => r.includes('» First I look at the tree.'))
  expect(said).toBeGreaterThan(-1)
  expect(rows.findIndex(r => r.includes('Read tree.ts'))).toBeGreaterThan(said)
  expect(rows.some(r => /tasks\s+1\/1 done/.test(r))).toBe(true)
  await ui.unmount()
})

test('a stub for a subagent no spawn announced is named from the agent list', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/a/b.md', agentId: 'id-resumed' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Resumed helper/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read b.md/ })).toBeDefined()
  await ui.unmount()
})

test('tasks stay after turn.complete and clear on prompt.submit, keeping a running subagent', async ($, on) => {
  const clock = { now: 1000 }
  engine(on as never, clock)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await $.agent.spawn(spawnInput('one', 'Still running'))
  await $.agent.spawn(spawnInput('two', 'Finished one'))
  await $.turn.complete({ turnId: 't', agentId: 'id-two', answer: '', reason: 'answer' } as never)
  await $.turn.complete({ turnId: 't', answer: '', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /List files/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Progress$/ })).toBeDefined()
  await ui.unmount()

  await $.prompt.submit({ text: 'next question' } as never)

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /List files/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /Finished one/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /Still running/ })).toBeDefined()
  await after.unmount()
})

test('the prompt shows on top: collapsed, cut at two lines, replaced by the next prompt, kept through the mod own command', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const top = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const rows = await frame(ui)
    await ui.unmount()
    return rows
  }

  // Nothing shows before the first prompt.
  expect((await top())[0]).toMatch(/^✓ Main/)

  await $.prompt.submit({ text: '  kun je bovenaan\n\n aangeven   welke prompt ' } as never)
  const first = await top()
  expect(first[0]).toBe('Prompt "kun je bovenaan aangeven welke prompt"')
  expect(first[1]).toBe(' ')
  expect(first[2]).toMatch(/^✓ Main/)

  await $.prompt.submit({ text: `${'a'.repeat(100)} ${'b'.repeat(100)} ${'c'.repeat(100)}` } as never)
  const long = await top()
  expect(long[0]).toBe(`Prompt "${'a'.repeat(72)}`)
  expect(long[1]).toBe(`${'a'.repeat(28)} ${'b'.repeat(49)}…"`)
  expect(long[2]).toBe(' ')
  expect(long[3]).toMatch(/^✓ Main/)

  // The mod's own command does not replace the prompt.
  await $.prompt.submit({ text: '/agent-monitor', command: { name: 'agent-monitor' } } as never)
  expect((await top())[0]).toBe(long[0])

  await $.prompt.submit({ text: 'volgende vraag' } as never)
  const next = await top()
  expect(next[0]).toBe('Prompt "volgende vraag"')
  expect(next).toHaveLength(3)
  expect(next[1]).toBe(' ')
  expect(next[2]).toMatch(/^✓ Main {2}\? · default$/)
})

test('Main keeps its own tasks through a subagent, a task notification and a turn end', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const typed = { origin: { kind: 'composer' }, wait: false } as const

  await $.prompt.submit({ text: 'doe iets', ...typed } as never)
  await $.tool.call({ tool: 'Bash', command: 'D=/x/y; ls $D', description: 'Map bekijken' })
  await $.agent.spawn(spawnInput('one', 'Helper'))
  await $.tool.call({ tool: 'Read', file_path: '/a/h.md', agentId: 'id-one' })
  // The subagent's report reaches the main loop as a notification, not a typed prompt.
  await $.prompt.submit({ text: '<task-notification/>', isMeta: true, origin: { kind: 'task-notification' }, wait: false } as never)
  await $.tool.call({ tool: 'SendMessage', to: 'x', message: 'hi' } as never)
  await $.turn.complete({ turnId: 't', agentId: 'id-one', answer: '', reason: 'answer' } as never)
  await $.turn.complete({ turnId: 't', answer: '', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await frame(ui)).toEqual([
    'Prompt "doe iets"',
    ' ',
    `✓ Main  ? · default`,
    '├─ ✓ Map bekijken',
    '├─ ✓ Helper  claude-haiku · default · 0s',
    '│  └─ ✓ Read h.md',
    '└─ ✓ SendMessage',
    ' ',
    'Progress',
    '  tasks    4/4 done',
    '  status   finished',
  ])
  await ui.unmount()

  // The person's next typed prompt does clear them.
  await $.prompt.submit({ text: 'volgende', ...typed } as never)
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await frame(after)).toHaveLength(3)
  await after.unmount()
})

test('a long line is cut to the pane width', async ($, on) => {
  const clock = { now: 1000 }
  engine(on as never, clock)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'x'.repeat(200), description: 'y'.repeat(200) })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  const label = (await ui.find({ type: 'Text', text: /^y+…?$/ }))?.text ?? ''
  expect(label.length + '└─ ✓ '.length).toBeLessThanOrEqual(30)
  await ui.unmount()
})

const row = (over: Partial<AgentMonitorRow>): AgentMonitorRow => ({
  id: 'x',
  description: '',
  subagentType: '',
  status: 'running',
  tasks: [],
  seq: 0,
  usd: 0,
  tokens: 0,
  isPriced: true,
  startedAt: 0,
  ...over,
})

test('the estimate uses the average of finished agents, a fallback, a cap and full when done', () => {
  const running = row({ startedAt: 0 })
  expect(expectedDurationMs([running])).toBe(60_000)
  expect(progressOf(running, 60_000, 30_000)).toBe(0.5)

  const finished = [row({ status: 'done', startedAt: 0, endedAt: 10_000 }), row({ status: 'done', startedAt: 0, endedAt: 30_000 })]
  expect(expectedDurationMs(finished)).toBe(20_000)

  expect(progressOf(running, 20_000, 500_000)).toBe(0.95)
  expect(progressOf(row({ status: 'done', startedAt: 0, endedAt: 1 }), 20_000, 0)).toBe(1)
})

test('the overall count and the bar', () => {
  expect(countAgents([])).toEqual({ done: 0, total: 0 })
  expect(countAgents([row({ status: 'done' }), row({}), row({})])).toEqual({ done: 1, total: 3 })
  expect(bar(0.5, 4)).toBe('██░░')
  expect(bar(2, 4)).toBe('████')
})

test('tool calls are labelled readably', () => {
  expect(describeTool('Bash', { command: 'ls -la', description: 'List files' })).toBe('List files')
  expect(describeTool('Bash', { command: 'ls -la' })).toBe('ls')
  expect(describeTool('Read', { file_path: '/a/b/register.tsx' })).toBe('Read register.tsx')
  expect(describeTool('Grep', { pattern: 'TODO' })).toBe('Grep: TODO')
  expect(describeTool('Skill', { skill: 'plugin-authoring' })).toBe('Skill: plugin-authoring')
  expect(describeTool('Agent', { description: 'Scan docs' })).toBe('Scan docs')
  expect(describeTool('Artifact', {})).toBe('Artifact')
})

test('a Bash call without a description gets a short label, never a raw path', () => {
  expect(summarizeCommand('D=/private/tmp/x/skills; T=$D/types/claude-code.d.ts; grep -n "foo" $T | head')).toBe('grep foo')
  expect(summarizeCommand('cd /a/b && npm test')).toBe('npm test')
  expect(summarizeCommand('sed -n 1,20p /a/b/register.tsx')).toBe('sed register.tsx')
  expect(summarizeCommand('FOO=1 ls')).toBe('ls')
  expect(describeTool('Bash', { command: 'D=/private/tmp/x; cat $D/a/notes.md' })).toBe('cat notes.md')
  // The arguments may arrive nested under `input`.
  expect(describeTool('Bash', { input: { command: 'ls', description: 'List files' } })).toBe('List files')
})

const usageOf = (model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): StepUsage => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

const step = async ($: { turn: { step: (input: never) => AsyncIterable<unknown> } }, index: number, agentId?: string) => {
  for await (const _ of $.turn.step({ turnId: 't', index, model: 'x', messageCount: 1, agentId } as never)) {
    // drain
  }
}

test('cost accumulates per agent across steps, main apart from subagents, with the session line', async ($, on) => {
  const world: { usage?: StepUsage; sessionUsd?: number } = { sessionUsd: 1.234 }
  engine(on as never, { now: 1000 }, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawnInput('one', 'Helper'))

  // Opus 5.5: $4 in, $20 out per MTok. Two steps of 100k in and 10k out: 2 x ($0.40 + $0.20) = $1.20.
  world.usage = usageOf('claude-opus-5-5', 100_000, 10_000)
  await step($ as never, 0)
  await step($ as never, 1)
  // Sonnet 5.5: $2 in, $10 out. 1M in, 100k out, plus cache read 1M ($0.20) and write 100k (2 x $2, the 1 hour TTL): $2 + $1 + $0.20 + $0.40.
  world.usage = usageOf('claude-sonnet-5-5', 1_000_000, 100_000, 1_000_000, 100_000)
  await step($ as never, 0, 'id-one')
  await $.turn.complete({ turnId: 't', answer: '', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await frame(ui)
  expect(rows[0]).toMatch(/^✓ Main {2}x · default · \$1\.20$/)
  expect(rows[1]).toMatch(/Helper {2}x · default · \$3\.45 · 0s$/)
  expect(rows.slice(rows.findIndex(r => r.startsWith('Details')))).toEqual(['Details  Cost  Skills & rules ', ' ', 'Costs per prompt and per session', '  prompt   $1.23', '  session  $1.23', expect.stringMatching(/^  cache    warm until \d\d:\d\d \(1h TTL, assumed\)$/), ' ', '  Top 2 most expensive in the session', '   1.   $3.45 ▸ Helper', '   2.   $1.20 ▸ main'])
  await ui.unmount()
})

test('a subagent step refreshes the cost lines while main takes no step, as with a forked skill', async ($, on) => {
  const world: { usage?: StepUsage; sessionUsd?: number } = { sessionUsd: 0 }
  engine(on as never, { now: 1000 }, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawnInput('one', 'Review'))

  world.sessionUsd = 0.2
  world.usage = usageOf('claude-sonnet-5-5', 100_000, 0)
  await step($ as never, 0, 'id-one')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await frame(ui)
  expect(rows.slice(rows.findIndex(r => r.startsWith('Details')))).toEqual(['Details  Cost  Skills & rules ', ' ', 'Costs per prompt and per session', '  prompt   $0.20', '  session  $0.20', ' ', '  Top 1 most expensive in the session', '   1.   $0.20 ▸ Review'])
  await ui.unmount()
})

test('an unknown model shows tokens, and a typed prompt resets the spend but not the session line', async ($, on) => {
  const world: { usage?: StepUsage; sessionUsd?: number } = { sessionUsd: 5 }
  engine(on as never, { now: 1000 }, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  world.usage = usageOf('some-new-model', 8000, 4000)
  await step($ as never, 0)
  await $.turn.complete({ turnId: 't', answer: '', reason: 'answer' } as never)
  const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await frame(before))[0]).toMatch(/Main {2}x · default · 12k tok$/)
  await before.unmount()

  await $.prompt.submit({ text: 'again', origin: { kind: 'composer' }, wait: false } as never)
  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await frame(after)
  expect(rows.find(r => r.includes('Main'))).toMatch(/Main  x · default$/)
  expect(rows.slice(rows.findIndex(r => r.startsWith('Details')))).toEqual(['Details  Cost  Skills & rules ', ' ', 'Costs per prompt and per session', '  prompt   $0.00', '  session  $5.00', expect.stringMatching(/^  cache    warm until \d\d:\d\d \(1h TTL, assumed\)$/), ' ', '  Top 1 most expensive in the session', '   1. 12k tok  main'])
  await after.unmount()
})

test('spend is formatted: under a cent, two decimals, tokens', () => {
  expect(formatUsd(0.004)).toBe('<$0.01')
  expect(formatUsd(0.42)).toBe('$0.42')
  expect(formatTokens(12_400)).toBe('12k tok')
  expect(formatSpend({ usd: 0, tokens: 0, isPriced: true })).toBe('')
  expect(formatSpend({ usd: 1, tokens: 5, isPriced: false })).toBe('5 tok')
})

test('skills used show per prompt and per session, counted, and the prompt list resets on a typed prompt', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const typed = { origin: { kind: 'composer' }, wait: false } as const
  const skillsLine = async () => {
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    if ((await pane.findAll({ key: 'tab-skills' } as never)).length > 0) await pane.press({ key: 'tab-skills' })
    const rows = await frame(pane)
    await pane.unmount()
    const at = rows.findIndex(r => r.startsWith('Details'))
    return !rows.some(r => r.includes(' Skills ')) ? undefined : rows.slice(at + 3).map(r => r.trim()).join(' | ')
  }

  await $.prompt.submit({ text: 'eerste', ...typed } as never)
  expect(await skillsLine()).toBeUndefined()
  await $.tool.call({ tool: 'Skill', skill: 'kb-ask' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'kb-ask', agentId: 'id-x' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'claude-api' } as never)
  expect(await skillsLine()).toBe('prompt & session (3) | • kb-ask (2) | • claude-api')

  await $.prompt.submit({ text: 'tweede', ...typed } as never)
  expect(await skillsLine()).toBe('prompt (0) | session (3) | • kb-ask (2) | • claude-api')
  await $.prompt.submit({ text: '<task-notification/>', isMeta: true, origin: { kind: 'task-notification' }, wait: false } as never)
  await $.tool.call({ tool: 'Skill', skill: 'openspec-new-change' } as never)
  expect(await skillsLine()).toBe('prompt (1) | • openspec-new-change | session (4) | • kb-ask (2) | • claude-api | • openspec-new-change')
})

test('progress never says finished while main is still busy, even with every task done', () => {
  const done = { id: 't1', label: 'Kijken', status: 'done' as const, seq: 1 }
  const progressLine = (status: 'running' | 'idle') =>
    buildTree(
      { prompt: '', main: row({ id: 'main', status, tasks: [done] }), agents: [], seq: 1 } as never,
      { now: 0, columns: 80 },
    )
      .map(l => l.text)
      .find(t => t.startsWith('  status'))

  expect(progressLine('running')).toBe('  status   working')
  expect(progressLine('idle')).toBe('  status   finished')
})

test('the footer keeps progress apart from a tab bar that shows only the selected tab', () => {
  const done = { id: 't1', label: 'Kijken', status: 'done' as const, seq: 1 }
  const footer = buildTree(
    {
      prompt: '',
      main: row({ id: 'main', status: 'idle', tasks: [done] }),
      agents: [],
      seq: 1,
      sessionUsd: 2,
      promptStartUsd: 1,
      promptSkills: ['kb-add'],
      sessionSkills: ['kb-add'],
    } as never,
    { now: 0, columns: 80, tab: 'skills' },
  )
    .filter(l => l.isFooter)
    .map(l => (l.tabs ? `${l.tabs.join(',')}:${l.tab}` : l.text))

  expect(footer).toEqual([
    '',
    'Progress',
    '  tasks    1/1 done',
    '  status   finished',
    '',
    '─'.repeat(80),
    'cost,skills:skills',
    '',
    'Skills invoked and rules loaded per prompt and per session',
    '  prompt & session (1)',
    '    • kb-add',
  ])
})

test('skills and rules share one list per prompt and per session in one tab', () => {
  const state = {
    prompt: '',
    main: row({ id: 'main', status: 'idle' }),
    agents: [],
    seq: 0,
    promptSkills: ['kb-ask'],
    sessionSkills: ['kb-ask'],
    promptRules: ['tests'],
    sessionRules: ['controllers', 'tests'],
  } as never
  const footer = buildTree(state, { now: 0, columns: 80, tab: 'skills' }).filter(l => l.isFooter)
  expect(footer.find(l => l.tabs)?.tabs).toEqual(['skills'])
  expect(footer.map(l => l.text.trim()).slice(-7)).toEqual(['prompt (2)', '• kb-ask', '• tests', 'session (3)', '• kb-ask', '• controllers', '• tests'])
})

test('a typed slash command starts a new prompt, the mod\'s own command does not', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const top = async () => {
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const rows = await frame(pane)
    await pane.unmount()
    return rows
  }

  await $.prompt.submit({ text: 'eerste vraag', origin: { kind: 'composer' }, wait: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Old task' })
  await $.prompt.submit({ text: '/code-review security config', command: { name: 'code-review' }, origin: { kind: 'composer' }, wait: false } as never)
  const rows = await top()
  expect(rows[0]).toBe('Prompt "/code-review security config"')
  expect(rows.some(r => r.includes('Old task'))).toBe(false)

  await $.prompt.submit({ text: '/agent-monitor', command: { name: 'agent-monitor' } } as never)
  expect((await top())[0]).toBe('Prompt "/code-review security config"')
})

test('a forked slash command, seen only as command.run, starts a new prompt', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const top = async () => {
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const rows = await frame(pane)
    await pane.unmount()
    return rows
  }

  await $.prompt.submit({ text: 'eerste vraag', origin: { kind: 'composer' }, wait: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Old task' })
  await $.command.run({ command: 'code-review', args: 'security config', origin: { kind: 'composer' } } as never)
  const rows = await top()
  expect(rows[0]).toBe('Prompt "/code-review security config"')
  expect(rows.some(r => r.includes('Old task'))).toBe(false)

  // A command a plugin runs is not the person's prompt.
  await $.command.run({ command: 'other', args: '', origin: { kind: 'plugin', name: 'x' } } as never)
  expect((await top())[0]).toBe('Prompt "/code-review security config"')
})

test('the context hint suggests /clear past half full and /compact past 80%', () => {
  expect(contextHint(undefined)).toBeUndefined()
  expect(contextHint(49)).toBeUndefined()
  expect(contextHint(50)).toBe('Hint: context 50% full, /clear before an unrelated task')
  expect(contextHint(79)).toBe('Hint: context 79% full, /clear before an unrelated task')
  expect(contextHint(80)).toBe('Hint: context 80% full, run /compact now')

  const footer = (contextPercent?: number) =>
    buildTree({ prompt: '', main: row({ id: 'main', status: 'idle' }), agents: [], seq: 0, contextPercent } as never, {
      now: 0,
      columns: 80,
    })
      .filter(l => l.isFooter)
      .map(l => l.text)
  expect(footer(30)).toEqual([])
  expect(footer(85)).toEqual(['', 'Hint: context 85% full, run /compact now'])
})

test('a prompt typed while main works is queued, not shown over the running one', () => {
  const task = { id: 't1', label: 'Old task', status: 'done' as const, seq: 1 }
  const busy = {
    prompt: 'oude vraag',
    main: row({ id: 'main', status: 'running', tasks: [task] }),
    agents: [],
    seq: 1,
  } as never as AgentMonitorState

  const queued = withPrompt(withPrompt(busy, 'nieuwe vraag'), '   ')
  expect(queued.prompt).toBe('oude vraag')
  expect(queued.queuedPrompts).toEqual(['nieuwe vraag'])
  expect(queued.main.tasks).toEqual([task])
  const rows = buildTree(queued, { now: 0, columns: 80 }).map(l => (l.lead ?? '') + l.text)
  expect(rows.slice(0, 2)).toEqual(['Prompt "oude vraag"', 'Queued: "nieuwe vraag"'])

  const after = promoteQueued({ ...queued, main: { ...queued.main, status: 'idle' } })
  expect(after.prompt).toBe('nieuwe vraag')
  expect(after.queuedPrompts).toBeUndefined()
  expect(after.main.tasks).toEqual([task])

  const fresh = withPrompt(after, 'derde vraag')
  expect(fresh.prompt).toBe('derde vraag')
  expect(fresh.main.tasks).toEqual([])
  expect(withPrompt(after, '')).toBe(after)
})

test('preloaded skills, skill files read by hand and rule files are recognized by their paths', () => {
  const header = 'Base directory for this skill: /repo/.claude/skills/kotlin-quality\n\n# Kotlin Quality'
  expect(skillsInText(textOf([{ type: 'text', text: header }]))).toEqual(['kotlin-quality'])
  expect(textOf([{ type: 'tool_result', content: header }])).toBe('')
  expect(rulesInText('Contents of /repo/.claude/rules/controllers.md and /repo/.claude/rules/controllers.md')).toEqual(['controllers'])
  expect(loadedByTool('Read', { file_path: '/repo/.claude/skills/spring-boot/SKILL.md' })).toEqual({ skills: ['spring-boot'], rules: [] })
  expect(loadedByTool('Bash', { command: 'cat ../.claude/rules/tests.md | head' })).toEqual({ skills: [], rules: ['tests'] })
  expect(loadedByTool('Grep', { pattern: '.claude/rules/tests.md' })).toEqual({ skills: [], rules: [] })
})

test('the footer lists rules per prompt and per session in the shared tab', () => {
  const state = {
    prompt: '',
    main: row({ id: 'main', status: 'idle' }),
    agents: [],
    seq: 0,
    sessionRules: ['controllers', 'tests'],
    promptRules: ['tests'],
  } as never
  const rows = buildTree(state, { now: 0, columns: 80, tab: 'skills' }).filter(l => l.isFooter).map(l => l.text.trim())
  expect(rows.slice(-7)).toEqual(['', 'Skills invoked and rules loaded per prompt and per session', 'prompt (1)', '• tests', 'session (2)', '• controllers', '• tests'])
})

test('skills show as a bulleted list under each label, and an empty list as a dash', () => {
  const state = {
    prompt: '',
    main: row({ id: 'main', status: 'idle' }),
    agents: [],
    seq: 0,
    sessionSkills: ['code-review', 'architecture', 'code-review'],
    promptSkills: [],
  } as never
  const rows = buildTree(state, { now: 0, columns: 40, tab: 'skills' }).filter(l => l.isFooter && !l.tabs).map(l => l.text)
  expect(rows).toEqual(['', '─'.repeat(40), '', 'Skills invoked and rules loaded per prompt and per session', '  prompt (0)', '  session (3)', '    • code-review (2)', '    • architecture'])
})

test('pressing a tab shows that tab and the choice survives a redraw', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'eerste', origin: { kind: 'composer' }, wait: false } as never)
  await $.tool.call({ tool: 'Skill', skill: 'kb-ask' } as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'tab-skills' })
  await pane.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await frame(again)
  await again.unmount()
  expect(rows.slice(-5)).toEqual(['Details  Skills & rules ', ' ', 'Skills invoked and rules loaded per prompt and per session', '  prompt & session (1)', '    • kb-ask'].slice(-5))
})

test('a skill row counts once when a Skill call announced it, and a preloaded one counts by itself', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'eerste', origin: { kind: 'composer' }, wait: false } as never)
  const row = (name: string) => ({
    message: { type: 'user', content: [{ type: 'text', text: `Base directory for this skill: /r/.claude/skills/${name}` }] },
  })
  await $.tool.call({ tool: 'Skill', skill: 'kb-ask' } as never)
  await $.session.append(row('kb-ask') as never)
  await $.session.append(row('architecture') as never)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'tab-skills' })
  const rows = await frame(pane)
  await pane.unmount()
  expect(rows.slice(rows.findIndex(r => r.startsWith('Details')) + 3).slice(0, 3).map(r => r.trim())).toEqual(['prompt & session (2)', '• kb-ask  .claude/skills/kb-ask', '• architecture  .claude/skills/architecture'])
})

test('skill and rule paths show relative to the session folder, home as ~ and shipped skills as built-in', () => {
  expect(displayPath('/repo/.claude/rules/tests.md', '/repo')).toBe('.claude/rules/tests.md')
  expect(displayPath('/Users/me/.claude/skills/kb-add', '/repo')).toBe('~/.claude/skills/kb-add')
  expect(displayPath('/Users/me/work/repo/.claude/skills/spring-ai', undefined)).toBe('.claude/skills/spring-ai')
  expect(displayPath('/Users/me/.claude/skills/kb-add', undefined)).toBe('~/.claude/skills/kb-add')
  expect(displayPath('/private/tmp/x/bundled-skills/2.1/abc/plugin-authoring', '/repo')).toBe('built-in')

  const state = {
    prompt: '',
    main: row({ id: 'main', status: 'idle' }),
    agents: [],
    seq: 0,
    cwd: '/repo',
    sessionRules: ['tests'],
    promptRules: [],
    rulePaths: { tests: '/repo/.claude/rules/tests.md' },
  } as never
  const rows = buildTree(state, { now: 0, columns: 80, tab: 'skills' }).filter(l => l.isFooter).map(l => `${l.text}${l.note ? `  ${l.note}` : ''}`)
  expect(rows.slice(-2)).toEqual(['  session (1)', '    • tests  .claude/rules/tests.md'])
})

test('a duration shows as seconds, minutes with seconds, or hours with minutes', () => {
  expect(formatDuration(42_000)).toBe('42s')
  expect(formatDuration(185_000)).toBe('3m 05s')
  expect(formatDuration(3_720_000)).toBe('1h 02m')
})

test('a done subagent shows how long it ran, a running one how long it has run so far', () => {
  const state = {
    prompt: '',
    main: row({ id: 'main', status: 'idle' }),
    agents: [
      row({ id: 'a', description: 'Finished', status: 'done', startedAt: 1_000, endedAt: 186_000, seq: 1 }),
      row({ id: 'b', description: 'Busy', status: 'running', startedAt: 1_000, seq: 2 }),
    ],
    seq: 2,
  } as never
  const lines = buildTree(state, { now: 3_721_000, columns: 80 })
  expect(lines.find(l => l.text === 'Finished')?.note).toMatch(/ · 3m 05s$/)
  expect(lines.find(l => l.text === 'Busy')?.note).toMatch(/ · 1h 02m$/)
})

test('a tool call the step listed but no tool.call hook announced is added once, when the turn completes', async ($, on) => {
  const world: World = {
    toolUses: [
      { name: 'Read', input: { file_path: '/a/notes.md' } },
      { name: 'Bash', input: { command: 'ls', description: 'List files' } },
    ],
  }
  engine(on as never, { now: 1000 }, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await step($ as never, 0)
  // Only one of the two goes through the hook.
  await $.tool.call({ tool: 'Read', file_path: '/a/notes.md' })
  await $.turn.complete({ turnId: 't', answer: '', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await frame(ui)
  await ui.unmount()
  expect(rows.filter(r => r.includes('Read notes.md'))).toHaveLength(1)
  expect(rows.filter(r => r.includes('List files'))).toHaveLength(1)
  expect(rows.filter(r => r.includes('✓ Read notes.md') || r.includes('✓ List files'))).toHaveLength(2)
})

test('the cost ranking keeps ten, replaces an entry by key and puts the priciest first', () => {
  const cost = (key: string, usd: number, tokens = 100) => ({ key, label: key, usd, tokens, isPriced: true })
  let top = rankCost(undefined, cost('a', 1))
  for (let i = 0; i < 12; i++) top = rankCost(top, cost(`k${i}`, i + 2))
  expect(top).toHaveLength(10)
  expect(top.map(c => c.key)).toEqual(['k11', 'k10', 'k9', 'k8', 'k7', 'k6', 'k5', 'k4', 'k3', 'k2'])

  const replaced = rankCost([cost('a', 1), cost('b', 2)], cost('a', 3))
  expect(replaced.map(c => `${c.key}:${c.usd}`)).toEqual(['a:3', 'b:2'])
  expect(rankCost(replaced, cost('z', 9, 0)).map(c => c.key)).toEqual(['a', 'b'])
})

test('two subagent steps and a main step all show in the Cost tab ranking, priciest first', async ($, on) => {
  const world: World = { sessionUsd: 1 }
  engine(on as never, { now: 1000 }, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawnInput('one', 'Cheap'))
  await $.agent.spawn(spawnInput('two', 'Pricey'))

  // Sonnet 5.5: $2 in per MTok. 100k = $0.20, 1M = $2.00, Opus 5.5 $4 in: 100k = $0.40.
  world.usage = usageOf('claude-sonnet-5-5', 100_000, 0)
  await step($ as never, 0, 'id-one')
  world.usage = usageOf('claude-sonnet-5-5', 1_000_000, 0)
  await step($ as never, 0, 'id-two')
  world.usage = usageOf('claude-opus-5-5', 100_000, 0)
  await step($ as never, 0)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = await frame(ui)
  await ui.unmount()
  expect(rows.slice(rows.findIndex(r => r.includes('Top 3 most expensive')))).toEqual([
    '  Top 3 most expensive in the session',
    '   1.   $2.00 ▸ Pricey',
    '   2.   $0.40 ▸ main',
    '   3.   $0.20 ▸ Cheap',
  ])
})

test('pressing an entry of the Cost ranking opens what it cost per kind of token and its priciest requests', async ($, on) => {
  const world: World = { sessionUsd: 1, said: 'Looking at the tree.' }
  engine(on as never, { now: 1000 }, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'why so pricey' } as never)

  // Opus 5.5: $4 in, $20 out per MTok. 100k in = $0.40, 10k out = $0.20.
  world.usage = usageOf('claude-opus-5-5', 100_000, 10_000)
  await step($ as never, 0)
  world.said = ''
  world.usage = usageOf('claude-opus-5-5', 50_000, 0)
  await step($ as never, 1)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await frame(ui)).some(r => r.includes('$0.80 ▸ "why so pricey"'))).toBe(true)
  await ui.press({ key: 'toggle-cost:prompt:1' })
  const rows = await frame(ui)
  const at = rows.findIndex(r => r.includes('$0.80 ▾ "why so pricey"'))
  expect(rows.slice(at + 1, at + 10).map(r => r.trim())).toEqual([
    '2 requests',
    'cache write  $0.00  0 tok',
    'cache read   $0.00  0 tok',
    'output       $0.20  10k tok',
    'input        $0.60  150k tok',
    'priciest requests',
    '$0.60  » Looking at the tree.',
    '$0.20  answer',
  ])
  await ui.unmount()
})

test('a typed prompt keeps the one it replaces in the history, the last ten only, a running loop frozen', () => {
  const start = { prompt: '', main: row({ id: 'main', status: 'idle' }), agents: [], seq: 0 } as never as AgentMonitorState
  const first = withPrompt(start, 'vraag 1')
  expect(first.history).toBeUndefined()

  const busy = { ...first, agents: [row({ id: 'a', status: 'running', startedAt: 5 })], sessionUsd: 0.4 }
  const second = withPrompt(busy, 'vraag 2')
  expect(second.history?.map(h => h.prompt)).toEqual(['vraag 1'])
  expect(second.history?.[0]?.agents[0]?.status).toBe('idle')
  expect(second.history?.[0]?.agents[0]?.endedAt).toBe(5)
  expect(second.history?.[0]?.endUsd).toBe(0.4)

  let s = second
  for (let i = 3; i <= 14; i++) s = withPrompt(s, `vraag ${i}`)
  expect(s.history?.length).toBe(10)
  expect(s.history?.[0]?.prompt).toBe('vraag 4')
})

test('the arrows browse earlier prompts within bounds, and a new prompt returns to live', async ($, on) => {
  engine(on as never, { now: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'eerste', origin: { kind: 'composer' }, wait: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'Old listing' })
  await $.prompt.submit({ text: 'tweede', origin: { kind: 'composer' }, wait: false } as never)

  const nav = async (key?: string) => {
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    if (key) await pane.press({ key })
    await pane.unmount()
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const rows = (await rowsOf(again)).filter(isNavRow).concat(await frame(again))
    const old = await again.find({ type: 'Text', text: /Old listing/ })
    await again.unmount()
    return { rows, old }
  }

  const live = await nav()
  expect(live.rows.some(r => r.includes('Prompt 2 / 2') && r.includes('latest'))).toBe(true)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const [navRow, under] = await rowsOf(pane)
  await pane.unmount()
  // The arrows sit at both edges of the 80-column pane, the label centred, a rule under them.
  expect(navRow?.length).toBe(80)
  expect(navRow?.endsWith(' Next › ')).toBe(true)
  expect(under).toBe('─'.repeat(80))
  expect(live.old).toBeUndefined()

  const back = await nav('nav-prev')
  expect(back.rows.some(r => r.includes('Prompt 1 / 2') && r.includes('history'))).toBe(true)
  expect(back.rows.some(r => r.includes('Prompt "eerste"'))).toBe(true)
  expect(back.old).toBeDefined()

  expect((await nav('nav-prev')).rows.some(r => r.includes('Prompt 1 / 2'))).toBe(true)
  expect((await nav('nav-next')).rows.some(r => r.includes('Prompt 2 / 2'))).toBe(true)
  expect((await nav('nav-next')).rows.some(r => r.includes('Prompt 2 / 2'))).toBe(true)

  await nav('nav-prev')
  await $.prompt.submit({ text: 'derde', origin: { kind: 'composer' }, wait: false } as never)
  expect((await nav()).rows.some(r => r.includes('Prompt 3 / 3') && r.includes('latest'))).toBe(true)
})

test('a stored state from before the history draws with no arrows', () => {
  const old = { prompt: 'vraag', main: row({ id: 'main', status: 'idle' }), agents: [], seq: 0 } as never as AgentMonitorState
  expect(withPrompt(old, 'nieuw').history?.map(h => h.prompt)).toEqual(['vraag'])
})

test('an earlier prompt shows its own prompt cost and lists, the session lines stay live', () => {
  const live = {
    prompt: 'nu',
    main: row({ id: 'main', status: 'idle' }),
    agents: [],
    seq: 0,
    sessionUsd: 1,
    promptStartUsd: 0.9,
    promptSkills: ['kb-add'],
    sessionSkills: ['kb-ask', 'kb-add'],
    topCosts: [{ key: 'prompt:1', label: 'top', usd: 0.5, tokens: 1, isPriced: true }],
  } as never as AgentMonitorState
  const snapshot = { prompt: 'eerder', main: live.main, agents: [], promptSkills: ['kb-ask'], promptRules: [], startUsd: 0.2, endUsd: 0.5 }
  const view = viewOf(live, snapshot)
  expect(Math.round(((view.sessionUsd ?? 0) - (view.promptStartUsd ?? 0)) * 100)).toBe(30)
  expect(view.sessionUsd).toBe(1)
  expect(view.promptSkills).toEqual(['kb-ask'])
  expect(view.sessionSkills).toEqual(['kb-ask', 'kb-add'])
  expect(view.topCosts).toBe(live.topCosts)
})

test('a prompt replaced by a queued one stays in the history, and two queued prompts both survive', () => {
  const busy = {
    prompt: 'eerste vraag',
    main: row({ id: 'main', status: 'running', tasks: [] }),
    agents: [],
    seq: 1,
  } as never as AgentMonitorState

  const queued = withPrompt(withPrompt(busy, 'tweede vraag'), 'derde vraag')
  const after = promoteQueued({ ...queued, main: { ...queued.main, status: 'idle' } })

  expect(after.prompt).toBe('derde vraag')
  expect((after.history ?? []).map(h => h.prompt)).toEqual(['eerste vraag', 'tweede vraag'])
})

const MINUTE = 60 * 1000

/** One request of main (or of `agentId`) on a priced model, with its effort. */
const priced = async (
  $: { turn: { step: (input: never) => AsyncIterable<unknown> } },
  options: { model?: string; effort?: string; agentId?: string } = {},
) => {
  const { model = 'claude-opus-5-5', effort = 'medium', agentId } = options
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model, effort, messageCount: 1, agentId } as never)) {
    // drain
  }
}

/** 300k tokens of context on Opus 5.5: rewriting it costs 300k x $4 x 2 = $2.40, above the $2 threshold. */
const BIG = 300_000

test('a cold cache above $2 asks first, and a refusal sends no request', async ($, on) => {
  const clock = { now: 0 }
  const world: World = { usage: usageOf('claude-opus-5-5', 1000, 100, 0, BIG) }
  engine(on as never, clock, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await priced($ as never)

  clock.now = 70 * MINUTE
  world.answer = 'Hold back'
  await priced($ as never)
  expect(world.asked).toHaveLength(1)
  expect(world.asked?.[0]).toMatch(/^Cold cache: cache expired \(70 min idle\)\. .*~301k tokens \(≈ \$2\.41\)/)
  expect(world.sent).toBe(1)

  world.answer = 'Continue'
  await priced($ as never)
  expect(world.asked).toHaveLength(2)
  expect(world.sent).toBe(2)
})

test('a cold cache below $2, or a warm one, sends without asking', async ($, on) => {
  const clock = { now: 0 }
  // 100k tokens: $0.80 to rewrite.
  const world: World = { usage: usageOf('claude-opus-5-5', 1000, 100, 0, 100_000) }
  engine(on as never, clock, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await priced($ as never)
  clock.now = 70 * MINUTE
  await priced($ as never)

  world.usage = usageOf('claude-opus-5-5', 1000, 100, 0, BIG)
  await priced($ as never)
  clock.now += 30 * MINUTE
  await priced($ as never)
  expect(world.asked ?? []).toHaveLength(0)
  expect(world.sent).toBe(4)
})

test('a change of model or effort counts as a cold cache', async ($, on) => {
  const clock = { now: 0 }
  const world: World = { usage: usageOf('claude-opus-5-5', 1000, 100, 0, BIG), answer: 'Continue' }
  engine(on as never, clock, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await priced($ as never)
  await priced($ as never, { effort: 'high' })
  await priced($ as never, { model: 'claude-fable-5-1', effort: 'high' })
  expect(world.asked?.[0]).toMatch(/^Cold cache: effort changes from medium to high\./)
  expect(world.asked?.[1]).toMatch(/^Cold cache: model changes from claude-opus-5-5 to claude-fable-5-1\./)
})

test('a fork keeps main\'s cache warm, a plain subagent does not', async ($, on) => {
  const clock = { now: 0 }
  const world: World = { usage: usageOf('claude-opus-5-5', 1000, 100, 0, BIG), answer: 'Continue' }
  engine(on as never, clock, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ ...spawnInput('fork', 'Review'), fork: true })
  await $.agent.spawn(spawnInput('plain', 'Lookup'))
  await priced($ as never)

  // From here on main's requests read their context from the cache: the TTL stays 1 hour.
  clock.now = 50 * MINUTE
  await priced($ as never, { agentId: 'id-fork' })
  clock.now = 100 * MINUTE
  world.usage = usageOf('claude-opus-5-5', 1000, 100, BIG, 1000)
  await priced($ as never)
  expect(world.asked ?? []).toHaveLength(0)

  // A plain subagent has its own context: none of main's comes from the cache.
  clock.now = 150 * MINUTE
  world.usage = usageOf('claude-opus-5-5', 1000, 100, 0, 20_000)
  await priced($ as never, { agentId: 'id-plain' })
  clock.now = 200 * MINUTE
  await priced($ as never)
  expect(world.asked).toHaveLength(1)
})

test('a fork idle past 5 minutes rewrites only its own part while main\'s prefix is warm', async ($, on) => {
  const clock = { now: 0 }
  const world: World = { usage: usageOf('claude-opus-5-5', 1000, 100, 0, BIG), answer: 'Continue' }
  engine(on as never, clock, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({ ...spawnInput('fork', 'Review'), fork: true })
  await priced($ as never)

  // The fork's first request reads main's prefix from the cache and writes its own part.
  clock.now = 1 * MINUTE
  world.usage = usageOf('claude-opus-5-5', 1000, 100, BIG, 200_000)
  await priced($ as never, { agentId: 'id-fork' })

  // 7 minutes later the fork's own 5 minute cache is cold, main's 1 hour one is not.
  clock.now = 8 * MINUTE
  await priced($ as never, { agentId: 'id-fork' })
  expect(world.asked ?? []).toHaveLength(0)

  // Once main's cache is cold too, the fork rewrites its whole context.
  clock.now = 80 * MINUTE
  await priced($ as never, { agentId: 'id-fork' })
  expect(world.asked).toHaveLength(1)
})

test('a subagent with no spawn whose first request reads main\'s context from the cache counts as a fork', async ($, on) => {
  const clock = { now: 0 }
  const world: World = { usage: usageOf('claude-opus-5-5', 1000, 100, 0, BIG), answer: 'Continue' }
  engine(on as never, clock, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await priced($ as never)

  clock.now = 50 * MINUTE
  world.usage = usageOf('claude-opus-5-5', 1000, 100, BIG, 2000)
  await priced($ as never, { agentId: 'id-forked-skill' })
  clock.now = 100 * MINUTE
  await priced($ as never)
  expect(world.asked ?? []).toHaveLength(0)
})

test('the TTL is measured from requests after a pause, and the Cost tab says which it is', async ($, on) => {
  const clock = { now: 0 }
  // The Cost tab shows once the session has a cost.
  const world: World = { usage: usageOf('claude-opus-5-5', 1000, 100, 0, BIG), answer: 'Continue', sessionUsd: 1 }
  engine(on as never, clock, world)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const cacheLine = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const line = (await frame(ui)).find(r => r.startsWith('  cache'))
    await ui.unmount()
    return line
  }
  await priced($ as never)
  expect(await cacheLine()).toMatch(/\(1h TTL, assumed\)$/)

  // A hit after 10 minutes: the 1 hour TTL.
  clock.now = 10 * MINUTE
  world.usage = usageOf('claude-opus-5-5', 1000, 100, BIG, 1000)
  await priced($ as never)
  expect(await cacheLine()).toMatch(/\(1h TTL, measured\)$/)

  // A miss after 10 minutes: the 5 minute TTL, and a cold cache after 6 minutes now asks.
  // A 5 minute write costs 1.25x, so it takes 500k tokens to pass $2: 500k x $4 x 1.25 = $2.50.
  clock.now = 20 * MINUTE
  world.usage = usageOf('claude-opus-5-5', 1000, 100, 0, 500_000)
  await priced($ as never)
  expect(await cacheLine()).toMatch(/\(5m TTL, measured\)$/)
  clock.now = 26 * MINUTE
  await priced($ as never)
  expect(world.asked?.at(-1)).toMatch(/^Cold cache: cache expired \(6 min idle\)\./)
})
