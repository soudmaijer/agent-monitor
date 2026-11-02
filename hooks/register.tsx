import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentMonitorRow, AgentMonitorState, AgentMonitorTask } from '../types'
import { APPROVAL_USD, ASSUMED_TTL, SHORT_TTL_MS, coldReason, contextTokensOf, measureTtl, rewriteUsd, sharesPrefix, warmedByFork } from './cache-guard'
import type { CacheTtl, LastStep } from './cache-guard'
import { describeTool } from './describe'
import { addUnique, loadedByTool, pathsInText, rulesInText, skillsInText, textOf } from './loaded'
import { costOf, rankCost, totalTokens, withStep } from './pricing'
import type { StepUsage } from './pricing'
import { isTypedPrompt, promoteQueued, viewOf, withPrompt } from './prompt'
import { TAB_LABELS, buildTree, fitLines } from './tree'
import type { FooterTab } from './tree'

const PANE = 'agent-monitor'
const KEEP = 30
const KEEP_TASKS = 50
const TICK_MS = 2000

const emptyRow = (id: string): AgentMonitorRow => ({
  id,
  description: '',
  subagentType: '',
  status: 'running',
  tasks: [],
  seq: 0,
  usd: 0,
  tokens: 0,
  isPriced: true,
  startedAt: 0,
})

const initial: AgentMonitorState = {
  prompt: '',
  main: { ...emptyRow('main'), description: 'main', status: 'idle' },
  seq: 0,
  agents: [],
}

// Change the tag when a row's fields change: it declines what an earlier
// version stored, which outlives a reload.
const monitor = atom({ plugin: 'agent-monitor', key: 'monitor' } as const, initial, {
  shape: 'monitor-6',
})

// The footer tab the person last picked.
const footerTab = atom({ plugin: 'agent-monitor', key: 'footerTab' } as const, 'cost' as FooterTab, { shape: 'footer-tab-1' })

// The earlier prompt the pane shows, as an index into `history`; LIVE shows the prompt running now.
const LIVE = -1
const viewing = atom({ plugin: 'agent-monitor', key: 'viewing' } as const, LIVE, { shape: 'viewing-1' })

// The nodes whose earlier children the person expanded, by row id.
const expanded = atom({ plugin: 'agent-monitor', key: 'expanded' } as const, [] as string[], { shape: 'expanded-1' })

// A counter the running timer bumps so the pane redraws and the estimated bars advance.
const tick = atom({ plugin: 'agent-monitor', key: 'tick' } as const, 0, { shape: 'tick-1' })

type Change = (row: AgentMonitorRow) => AgentMonitorRow

// Applies a change to the main row, or to the subagent row with that id.
// A subagent seen before its spawn returned gets a stub row, which the spawn
// result later fills in.
const change = (
  state: AgentMonitorState,
  agentId: string | undefined,
  now: number,
  apply: Change,
): AgentMonitorState => {
  if (!agentId) return { ...state, main: apply(state.main) }
  if (state.agents.some(a => a.id === agentId)) {
    return { ...state, agents: state.agents.map(a => (a.id === agentId ? apply(a) : a)) }
  }
  const seq = state.seq + 1
  const stub = { ...emptyRow(agentId), seq, startedAt: now }
  return { ...state, seq, agents: [...state.agents, apply(stub)].slice(-KEEP) }
}

// Shows a new prompt at the top and clears what the last one left on screen; a
// subagent still running stays, with its node.
async function startPrompt($: EngineInterface, text: string) {
  await refreshSessionCost($)
  await update($, monitor, s => withPrompt(s, text))
  // A new prompt brings the pane back from an earlier one.
  await update($, viewing, () => LIVE)
}

// Drawn as filled buttons, like the selected tab, so they read as something to press.
const ARROW_PREV = ' ‹ Prev '
const ARROW_NEXT = ' Next › '

/** The spaces left and right of a label of `width` centred in `room` columns. */
const centered = (width: number, room: number) => {
  const free = Math.max(0, room - width)
  return { left: Math.floor(free / 2), right: Math.ceil(free / 2) }
}

/** Moves the pane one prompt back (-1) or forward (+1); past the newest earlier prompt is the live one. */
async function browse($: EngineInterface, step: -1 | 1) {
  const count = (await read($, monitor)).history?.length ?? 0
  await update($, viewing, at => {
    const next = Math.max(0, (at === LIVE ? count : at) + step)
    return next >= count ? LIVE : next
  })
}

// The session's exact cost, as the engine counts it. Failing to read it is not worth failing a hook.
async function refreshSessionCost($: EngineInterface) {
  const usage = await $.session.usage().catch(() => undefined)
  const usd = usage?.cost?.usd
  const contextPercent = usage?.context?.percent
  await update($, monitor, s => ({
    ...s,
    ...(usd !== undefined ? { sessionUsd: usd } : {}),
    ...(contextPercent !== undefined ? { contextPercent } : {}),
  }))
}

// A subagent seen without an `agent.spawn` (resumed by SendMessage, say) has only
// a stub row: name it from the engine's agent list.
async function nameStub($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return
  const row = (await read($, monitor)).agents.find(a => a.id === agentId)
  if (!row || row.description !== '') return
  const info = (await $.agent.list()).find(a => a.id === agentId)
  if (!info) return
  await update($, monitor, s => ({
    ...s,
    agents: s.agents.map(a =>
      a.id === agentId && a.description === ''
        ? {
            ...a,
            description: info.description || info.name || info.type || 'agent',
            subagentType: info.type,
            parentId: a.parentId ?? info.parentId,
          }
        : a,
    ),
  }))
}

async function addSkills($: EngineInterface, skills: string[]) {
  if (skills.length === 0) return
  await update($, monitor, s => ({
    ...s,
    promptSkills: [...(s.promptSkills ?? []), ...skills],
    sessionSkills: [...(s.sessionSkills ?? []), ...skills],
  }))
}

/** Remembers where the skills and rules a text names live; a later sighting does not move one. */
async function addPaths($: EngineInterface, text: string) {
  const found = pathsInText(text)
  if (Object.keys(found.skills).length === 0 && Object.keys(found.rules).length === 0) return
  await update($, monitor, s => ({
    ...s,
    skillPaths: { ...found.skills, ...s.skillPaths },
    rulePaths: { ...found.rules, ...s.rulePaths },
  }))
}

async function addRules($: EngineInterface, rules: string[]) {
  if (rules.length === 0) return
  await update($, monitor, s => ({
    ...s,
    promptRules: addUnique(s.promptRules, rules),
    sessionRules: addUnique(s.sessionRules, rules),
  }))
}

// Skill calls whose instruction row has not arrived yet, by loop and skill.
const announced = new Map<string, number>()

const announce = (loop: string, skill: string) =>
  announced.set(`${loop}:${skill}`, (announced.get(`${loop}:${skill}`) ?? 0) + 1)

/** Takes one pending announcement of the skill in that loop; false when there is none. */
const consume = (loop: string, skill: string): boolean => {
  const pending = announced.get(`${loop}:${skill}`) ?? 0
  if (pending === 0) return false
  announced.set(`${loop}:${skill}`, pending - 1)
  return true
}

// The tool calls each loop's last step asked for, and the seq before they ran. A
// plugin above this one (an organization's) can continue past its tool.call hook, so
// those calls never reach it: they are added from here once the step is over.
type AskedUse = { label: string; name: string; input: Record<string, unknown> }

const asked = new Map<string, { uses: AskedUse[]; seq: number }>()

/** The asked uses with no task since `seq`, matched by label, each task once. */
const missingUses = (row: AgentMonitorRow, uses: AskedUse[], seq: number): AskedUse[] => {
  const seen = row.tasks.filter(t => t.seq > seq).map(t => t.label)
  return uses.filter(use => {
    const at = seen.indexOf(use.label)
    if (at === -1) return true
    seen.splice(at, 1)
    return false
  })
}

async function recoverSkipped($: EngineInterface, agentId: string | undefined) {
  const loop = agentId ?? 'main'
  const step = asked.get(loop)
  asked.delete(loop)
  if (!step || step.uses.length === 0) return
  const state = await read($, monitor)
  const row = agentId ? state.agents.find(a => a.id === agentId) : state.main
  if (!row) return
  const missing = missingUses(row, step.uses, step.seq)
  if (missing.length === 0) return
  // What a skipped call loaded counts too, as its tool.call hook would have counted it.
  for (const use of missing) {
    const skill = use.name === 'Skill' ? use.input.skill : undefined
    if (typeof skill === 'string' && skill !== '') await addSkills($, [skill])
    const opened = loadedByTool(use.name, use.input)
    await addSkills($, opened.skills)
    await addRules($, opened.rules)
  }
  const now = await $.clock.now()
  await update($, monitor, s => {
    let seq = s.seq
    const added = missing.map(use => ({ id: `skipped-${(seq += 2)}`, label: use.label, seq, status: 'done' as const }))
    const changed = change(s, agentId, now, r => ({ ...r, tasks: [...r.tasks, ...added].slice(-KEEP_TASKS) }))
    return { ...changed, seq: Math.max(changed.seq, seq) }
  })
}

// Each loop's last request, for predicting a cold cache on its next one.
const lastSteps = new Map<string, LastStep>()
// Each fork's parent loop: a fork's requests keep its parent's cache warm.
const forkParents = new Map<string, string>()
// How much of each fork's context is its parent's prefix, read from the cache on its first request.
const forkPrefixTokens = new Map<string, number>()
// The TTL main's cache runs on, measured from main's requests after a pause once one shows it.
let cacheTtl: CacheTtl = ASSUMED_TTL

/**
 * Records a loop's request: what it shows of the TTL, whether a subagent shares
 * main's prefix (a forked skill makes no agent.spawn that says so), and the last
 * step of every loop it is a fork of, moved up.
 */
function recordStep(loop: string, step: LastStep, usage: StepUsage) {
  const last = lastSteps.get(loop)
  if (last && loop === 'main') cacheTtl = measureTtl(cacheTtl, last, step, usage)
  const main = lastSteps.get('main')
  if (!last && loop !== 'main' && !forkParents.has(loop) && main && sharesPrefix(main, step, usage)) {
    forkParents.set(loop, 'main')
  }
  if (!last && forkParents.has(loop)) forkPrefixTokens.set(loop, usage.cache_read_input_tokens)
  lastSteps.set(loop, step)
  for (let parent = forkParents.get(loop); parent; parent = forkParents.get(parent)) {
    const parentStep = lastSteps.get(parent)
    if (parentStep) lastSteps.set(parent, warmedByFork(parentStep, step.model, step.at))
  }
}
// Claude Code gives the 1 hour TTL only to the main conversation: subagents and forks get 5 minutes.
const ttlOf = (loop: string) => (loop === 'main' ? cacheTtl.ms : SHORT_TTL_MS)

// A fork's prefix sits in its parent's cache: while that is warm, a cold fork rewrites only its own part.
function warmPrefixTokens(loop: string, step: { model: string; effort?: string | number }, now: number): number {
  const parent = forkParents.get(loop)
  const parentStep = parent ? lastSteps.get(parent) : undefined
  if (!parent || !parentStep || coldReason(parentStep, step, ttlOf(parent), now)) return 0
  return forkPrefixTokens.get(loop) ?? 0
}

const GO = 'Continue'
const STOP = 'Hold back'

// A request that will find the cache cold rewrites the whole context: above
// APPROVAL_USD the person decides whether it goes out. A reload forgets the
// last steps, so the first request after one is never asked about.
async function approveColdCache(
  $: EngineInterface,
  loop: string,
  step: { model: string; effort?: string | number },
  now: number,
): Promise<boolean> {
  const last = lastSteps.get(loop)
  if (!last) return true
  const reason = coldReason(last, step, ttlOf(loop), now)
  const tokens = last.contextTokens - warmPrefixTokens(loop, step, now)
  const usd = rewriteUsd(tokens, step.model, ttlOf(loop))
  if (!reason || usd === undefined || usd < APPROVAL_USD) return true
  const question = `Cold cache: ${reason}. This step rewrites ~${Math.round(tokens / 1000)}k tokens (≈ $${usd.toFixed(2)}). Continue?`
  const answer = await $.ui.ask(question, { header: 'Cache', options: [GO, STOP] }).catch(() => STOP)
  return answer === GO
}

// Runs only while main or a subagent runs, so the elapsed times advance. A reload drops the timer with the module.
let ticker: Timer | undefined

function startTicking($: EngineInterface) {
  if (ticker) return
  ticker = $.clock.every(TICK_MS, async () => {
    const { main, agents } = await read($, monitor)
    if (main.status === 'running' || agents.some(a => a.status === 'running')) {
      await update($, tick, n => n + 1)
    } else {
      ticker?.cancel()
      ticker = undefined
    }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-monitor',
      description: 'Show the running agents, models and effort in a pane (`hide` closes it)',
    })
    await update($, monitor, s => ({ ...s, cwd: e.cwd }))
    // A new session, or a reload, starts with no requests seen.
    lastSteps.clear()
    forkParents.clear()
    forkPrefixTokens.clear()
    cacheTtl = ASSUMED_TTL
    void $.ui.open({ id: PANE, title: 'Agents' })

    return next(e)
  })

  on('command.run', { command: 'agent-monitor' }, async ($, e) => {
    if (e.args.trim() === 'hide') {
      await $.ui.close({ id: PANE })

      return { text: 'Agent monitor pane hidden. Run /agent-monitor to show it again.' }
    }
    await $.ui.open({ id: PANE, title: 'Agents' })

    return { text: 'Agent monitor pane opened.' }
  })

  // A new typed prompt is shown at the top and clears what the last one left on screen.
  // A background task's notification or a peer's message arrives through prompt.submit
  // too, mid-turn: only the person's own prompt resets; a
  // subagent still running stays, with its node.
  on('prompt.submit', async ($, e, next) => {
    if (isTypedPrompt(e)) await startPrompt($, e.text)

    return next(e)
  })

  // A slash command typed by the person is a new prompt too. A forked skill such as
  // /code-review runs as a background agent and never reaches prompt.submit, so the
  // command itself is the only sign that the person started something new.
  on('command.run', async ($, e, next) => {
    if (e.command !== 'agent-monitor' && e.origin.kind === 'composer') {
      await startPrompt($, `/${e.command} ${e.args}`)
      // A skill typed as a slash command makes no Skill call; a forked one loads in a
      // loop whose id is not known yet, so its instruction row is matched in any loop.
      const info = (await $.command.list().catch(() => [])).find(c => c.name === e.command)
      if (info && (info.source === 'user' || info.source === 'plugin')) {
        announce('*', e.command)
        await addSkills($, [e.command])
      }
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, monitor, s =>
      change(s, e.agentId, now, r => (e.agentId ? r : { ...r, status: 'running', startedAt: now, endedAt: undefined })),
    )
    startTicking($)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, monitor, s =>
      change(s, e.agentId, now, r =>
        e.agentId
          ? { ...r, status: 'done', endedAt: now }
          : { ...r, status: 'idle', tool: undefined, endedAt: now },
      ),
    )
    await recoverSkipped($, e.agentId)
    // A prompt queued during the turn was answered in it: it becomes the prompt shown,
    // and its work stays listed under it.
    if (!e.agentId) {
      await update($, monitor, promoteQueued)
    }
    await refreshSessionCost($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const now = await $.clock.now()
    if (!(await approveColdCache($, e.agentId ?? 'main', e, now))) {
      $.ui.toast('Step held back: cold cache not approved')
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }
    await update($, monitor, s =>
      change(s, e.agentId, now, r => ({ ...r, model: e.model, effort: e.effort })),
    )

    await nameStub($, e.agentId)
    // The tool calls of the previous step have all run by now.
    await recoverSkipped($, e.agentId)

    const result = yield* next(e)
    // The text the model wrote in this step comes before the tool calls it asked for.
    const said = result?.answer?.replace(/\s+/g, ' ').trim()
    if (said) {
      await update($, monitor, s => {
        const seq = s.seq + 2
        const text = { id: `text-${seq}`, label: said, seq, status: 'done' as const, isText: true }
        const changed = change(s, e.agentId, now, r => ({ ...r, tasks: [...r.tasks, text].slice(-KEEP_TASKS) }))
        return { ...changed, seq: Math.max(changed.seq, seq) }
      })
    }
    if (result?.toolUses?.length) {
      const seq = (await read($, monitor)).seq
      const uses = result.toolUses
        .filter(use => use.name !== 'Agent')
        .map(use => {
          const input = (use.input ?? {}) as Record<string, unknown>
          return { label: describeTool(use.name, input), name: use.name, input }
        })
      asked.set(e.agentId ?? 'main', { uses, seq })
    }

    if (result?.usage) {
      const usage = result.usage
      // The cache's timer runs from the start of the request, so `now` (taken before it went out).
      recordStep(e.agentId ?? 'main', { at: now, model: e.model, effort: e.effort, contextTokens: contextTokensOf(usage) }, usage)
      const mainStep = lastSteps.get('main')
      if (mainStep) {
        const cache = { expiresAt: mainStep.at + cacheTtl.ms, ttlMs: cacheTtl.ms, isMeasured: cacheTtl.isMeasured }
        await update($, monitor, s => ({ ...s, cache }))
      }
      const ttlMs = ttlOf(e.agentId ?? 'main')
      const usd = costOf(usage, ttlMs)
      // What the request did: the text it wrote, else the tool calls it asked for.
      const did = said ? `» ${said}` : (result.toolUses ?? []).map(use => describeTool(use.name, (use.input ?? {}) as Record<string, unknown>)).join(', ')
      await update($, monitor, s =>
        change(s, e.agentId, now, r => ({
          ...r,
          usd: r.usd + (usd ?? 0),
          tokens: r.tokens + totalTokens(usage),
          isPriced: r.isPriced && usd !== undefined,
          breakdown: withStep(r.breakdown, usage, ttlMs, did || 'answer'),
        })),
      )
      await update($, monitor, s => {
        const row = e.agentId ? s.agents.find(a => a.id === e.agentId) : s.main
        if (!row) return s
        const entry = e.agentId
          ? { key: `agent:${row.id}`, label: row.description || row.subagentType || 'agent' }
          : { key: `prompt:${s.promptId ?? 0}`, label: s.prompt === '' ? 'main' : `"${s.prompt}"` }
        return {
          ...s,
          topCosts: rankCost(s.topCosts, { ...entry, usd: row.usd, tokens: row.tokens, isPriced: row.isPriced, breakdown: row.breakdown }),
        }
      })
    }
    // A forked skill runs entirely as a subagent, so its steps must refresh the cost too.
    await refreshSessionCost($)

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    const pending: AgentMonitorRow = {
      ...emptyRow(e.tool_use_id),
      toolUseId: e.tool_use_id,
      parentId: e.parentAgentId,
      description: e.description,
      subagentType: e.subagentType,
      model: e.model,
      startedAt: now,
    }
    await update($, monitor, s => ({
      ...s,
      seq: s.seq + 1,
      agents: [...s.agents, { ...pending, seq: s.seq + 1 }].slice(-KEEP),
    }))
    startTicking($)

    const spawned = await next(e)
    if (e.fork && spawned.agentId) forkParents.set(spawned.agentId, e.parentAgentId ?? 'main')

    // The subagent's own events may have made a stub under its id already:
    // fold the pending row into it, or give the pending row its id.
    await update($, monitor, s => {
      const agentId = spawned.agentId
      const placed = s.agents.find(a => a.toolUseId === e.tool_use_id) ?? pending
      const rest = s.agents.filter(a => a.toolUseId !== e.tool_use_id)
      if (!agentId || spawned.deny !== undefined) {
        return { ...s, agents: rest.concat({ ...placed, status: 'failed', endedAt: now }) }
      }
      const stub = s.agents.find(a => a.id === agentId)
      const merged: AgentMonitorRow = {
        ...placed,
        ...(stub ?? {}),
        id: agentId,
        parentId: placed.parentId,
        description: placed.description,
        subagentType: placed.subagentType,
        model: stub?.model ?? spawned.model,
        seq: placed.seq,
        startedAt: placed.startedAt,
      }
      return {
        ...s,
        agents: rest.filter(a => a.id !== agentId).concat(merged).slice(-KEEP),
      }
    })

    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const now = await $.clock.now()
    const id = e.tool_use_id ?? `${e.tool}-${now}`
    const label = describeTool(String(e.tool), e as unknown as Record<string, unknown>)
    // An Agent call shows as the subagent's own node, not as a task.
    const isTask = e.tool !== 'Agent'
    const skill = e.tool === 'Skill' ? (e as unknown as { skill?: unknown }).skill : undefined
    if (typeof skill === 'string' && skill !== '') {
      // Its instructions arrive as a row with the skill header: that row must not count it again.
      announce(e.agentId ?? 'main', skill)
      await addSkills($, [skill])
    }
    const opened = loadedByTool(String(e.tool), e as unknown as Record<string, unknown>)
    const input = e as unknown as { file_path?: unknown; command?: unknown }
    await addPaths($, [input.file_path, input.command].filter(v => typeof v === 'string').join('\n'))
    await addSkills($, opened.skills)
    await addRules($, opened.rules)
    await update($, monitor, s => {
      const seq = s.seq + 2
      const changed = change(s, e.agentId, now, r => ({
        ...r,
        tasks: isTask ? [...r.tasks, { id, label, seq, status: 'running' as const }].slice(-KEEP_TASKS) : r.tasks,
      }))
      return { ...changed, seq: Math.max(changed.seq, seq) }
    })

    await nameStub($, e.agentId)

    const ran = await next(e)

    const status: AgentMonitorTask['status'] = ran.deny !== undefined || ran.isError ? 'failed' : 'done'
    await update($, monitor, s =>
      change(s, e.agentId, now, r => ({
        ...r,
        tasks: r.tasks.map(t => (t.id === id ? { ...t, status } : t)),
      })),
    )

    return ran
  })

  // Every row of every loop: skills a subagent type preloads and rules attached for
  // the files a loop touches never pass through a Skill call.
  on('session.append', async ($, e, next) => {
    const { type, content } = e.message
    if (type === 'user' || type === 'attachment') {
      const text = textOf(content)
      await addPaths($, text)
      const loop = e.agentId ?? 'main'
      const skills = skillsInText(text).filter(skill => !consume(loop, skill) && !consume('*', skill))
      await addSkills($, skills)
      if (type === 'attachment') await addRules($, rulesInText(text))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const live = await read($, monitor)
    const history = live.history ?? []
    const at = await read($, viewing)
    const snapshot = history[at]
    const state = snapshot ? viewOf(live, snapshot) : live
    const now = await $.clock.now()
    await read($, tick)
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 60
    // The arrows row and the empty line under it.
    const rows = Math.max(3, (e.viewport?.rows ?? 24) - 4 - 2)
    const position = (snapshot ? at : history.length) + 1
    const navLabel = `Prompt ${position} / ${history.length + 1} · ${snapshot ? 'history' : 'latest'}`
    const navPad = centered(navLabel.length, columns - ARROW_PREV.length - ARROW_NEXT.length)
    // The Rules tab of an earlier version now lives in the Skills & rules tab.
    const stored = await read($, footerTab)
    const tab = stored === 'rules' ? 'skills' : stored
    const open = await read($, expanded)
    const lines = fitLines(buildTree(state, { now, columns, tab, expanded: open }), rows, columns)
    const toggle = (id: string) => update($, expanded, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))

    return (
      <Box flexDirection="column">
        {(
          <Box flexDirection="row">
            <Button key="nav-prev" plain onPress={() => browse($, -1)}>
              {position === 1
                ? <Text dimColor>{ARROW_PREV}</Text>
                : <Text bold backgroundColor="inactive" color="inverseText">{ARROW_PREV}</Text>}
            </Button>
            <Text>{' '.repeat(navPad.left)}</Text>
            <Text bold color="permission">{navLabel}</Text>
            <Text>{' '.repeat(navPad.right)}</Text>
            <Button key="nav-next" plain onPress={() => browse($, 1)}>
              {snapshot
                ? <Text bold backgroundColor="inactive" color="inverseText">{ARROW_NEXT}</Text>
                : <Text dimColor>{ARROW_NEXT}</Text>}
            </Button>
          </Box>
        )}
        {<Box><Text color="permission">{'─'.repeat(columns)}</Text></Box>}
        {lines.map(l => l.isRule ? (
          <Text color="permission">{l.text}</Text>
        ) : l.tabs !== undefined ? (
          <Box flexDirection="row" gap={1}>
            <Text bold color="permission">{'Details '}</Text>
            {l.tabs.map(t => (
              <Button key={`tab-${t}`} plain onPress={() => update($, footerTab, () => t)}>
                {l.tab === t
                  ? <Text bold backgroundColor="inactive" color="inverseText">{` ${TAB_LABELS[t]} `}</Text>
                  : <Text>{` ${TAB_LABELS[t]} `}</Text>}
              </Button>
            ))}
          </Box>
        ) : l.toggles !== undefined ? (
          <Box flexDirection="row">
            <Text dimColor>{l.prefix}</Text>
            <Button key={`toggle-${l.toggles}`} plain onPress={() => toggle(l.toggles!)}>
              <Text dimColor={l.isDim}>{l.text}</Text>
            </Button>
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text dimColor>{l.prefix}</Text>
            {l.status === 'done' && <Text color="green">{'✓ '}</Text>}
            {l.status === 'failed' && <Text color="red">{'✗ '}</Text>}
            {l.status === 'running' && <Text color="yellow">{'● '}</Text>}
            {l.lead && <Text bold color="permission">{l.lead}</Text>}
            <Text bold={l.isBold} dimColor={l.isDim}>{l.text === '' ? ' ' : l.text}</Text>
            {l.note !== '' && <Text dimColor>{`  ${l.note}`}</Text>}
            {l.bar !== '' && <Text>{`  ${l.bar}`}</Text>}
            {l.right && <Text>{' '.repeat(l.pad)}</Text>}
            {l.right && <Text dimColor={l.rightStatus !== 'running'}>{l.right}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
