import type { AgentMonitorRow, AgentMonitorSnapshot, AgentMonitorState } from '../types'

const MAX_PROMPT = 500
const KEEP_HISTORY = 10

const NOT_TYPED = new Set([
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'channel',
  'coordinator',
  'observer',
  'observer-activity',
  'auto-continuation',
  'unclassified',
  'slack-ping',
  'plugin',
])

/** This mod's own command only reopens the pane; it starts no new work. */
const OWN_COMMAND = 'agent-monitor'

/**
 * Whether a submission is a prompt the person typed, a slash command such as
 * `/code-review` included. Meta prompts and what the engine queues for itself
 * (a background task's notification, a peer's message, a schedule) are not:
 * they arrive through `prompt.submit` too, mid-turn, and must not clear or
 * replace what is shown. Neither is `/agent-monitor` itself.
 */
export const isTypedPrompt = (e: { command?: { name?: string }; isMeta?: true; origin?: { kind: string } }): boolean =>
  e.command?.name !== OWN_COMMAND && !e.isMeta && !NOT_TYPED.has(e.origin?.kind ?? '')

/**
 * The state after the person submits `text`. A prompt typed while main still works
 * joins the running turn: it is queued beside the current one rather than wiping
 * the work still on screen. Otherwise it becomes the prompt shown, and what the
 * last one left is cleared, a subagent still running kept with its node.
 */
export const withPrompt = (s: AgentMonitorState, text: string): AgentMonitorState => {
  const prompt = text.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT)
  if (prompt === '') return s
  if (s.main.status === 'running') return { ...s, queuedPrompts: [...(s.queuedPrompts ?? []), prompt] }
  const history = s.prompt === '' ? s.history : [...(s.history ?? []), snapshotOf(s)].slice(-KEEP_HISTORY)
  return {
    ...s,
    history,
    promptId: (s.promptId ?? 0) + 1,
    promptStartUsd: s.sessionUsd ?? 0,
    promptSkills: [],
    promptRules: [],
    prompt,
    queuedPrompts: undefined,
    main: { ...s.main, tasks: [], usd: 0, tokens: 0, isPriced: true, breakdown: undefined },
    agents: s.agents.filter(a => a.status === 'running'),
  }
}

/** A loop still running when its prompt was replaced is frozen there: shown as interrupted, its time stopped. */
const frozen = (row: AgentMonitorRow, at: number): AgentMonitorRow =>
  row.status === 'running' ? { ...row, status: 'idle', endedAt: at } : row

/** The prompt shown now, as it stands, to keep in the history. */
const snapshotOf = (s: AgentMonitorState): AgentMonitorSnapshot => {
  const at = Math.max(s.main.endedAt ?? 0, ...s.agents.map(a => a.endedAt ?? a.startedAt))
  return {
    prompt: s.prompt,
    main: frozen(s.main, at),
    agents: s.agents.map(a => frozen(a, at)),
    promptSkills: s.promptSkills ?? [],
    promptRules: s.promptRules ?? [],
    startUsd: s.promptStartUsd ?? 0,
    endUsd: s.sessionUsd ?? 0,
  }
}

/**
 * The state drawn for an earlier prompt: its own tree, prompt cost and prompt lists.
 * Every session line stays live, so `session` always means the session so far.
 */
export const viewOf = (s: AgentMonitorState, snapshot: AgentMonitorSnapshot): AgentMonitorState => ({
  ...s,
  prompt: snapshot.prompt,
  queuedPrompts: undefined,
  main: snapshot.main,
  agents: snapshot.agents,
  promptSkills: snapshot.promptSkills,
  promptRules: snapshot.promptRules,
  // The prompt line is drawn as the live session cost minus the prompt's start.
  promptStartUsd: (s.sessionUsd ?? 0) - (snapshot.endUsd - snapshot.startUsd),
  contextPercent: undefined,
})

/**
 * At the end of main's turn the queued prompts were answered in it: the last becomes
 * the prompt shown, its work kept. Each prompt it replaces goes to the history first.
 */
export const promoteQueued = (s: AgentMonitorState): AgentMonitorState => {
  const queued = s.queuedPrompts ?? []
  if (queued.length === 0) return s
  const replaced = [s.prompt, ...queued.slice(0, -1)].filter(prompt => prompt !== '')
  const history = [...(s.history ?? []), ...replaced.map(prompt => ({ ...snapshotOf(s), prompt }))].slice(-KEEP_HISTORY)
  return { ...s, history, prompt: queued[queued.length - 1] ?? s.prompt, queuedPrompts: undefined }
}
