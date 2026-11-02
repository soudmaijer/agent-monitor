import type { AgentMonitorRow, AgentMonitorState, AgentMonitorUsage } from '../types'

const KEEP_USAGE = 200

/** What the Agents tab needs of a subagent row. */
export const usageOf = (row: AgentMonitorRow): AgentMonitorUsage => ({
  id: row.id,
  type: row.subagentType || 'agent',
  model: row.model,
  effort: row.effort,
  usd: row.usd,
  tokens: row.tokens,
  isPriced: row.isPriced,
})

/** Copies the subagent's row into the session's agent usage, which outlives the prompt. */
export const withUsage = (state: AgentMonitorState, agentId: string | undefined): AgentMonitorState => {
  const row = agentId ? state.agents.find(a => a.id === agentId) : undefined
  if (!row || row.toolUseId === row.id) return state
  const rest = (state.sessionAgents ?? []).filter(u => u.id !== row.id)
  return { ...state, sessionAgents: [...rest, usageOf(row)].slice(-KEEP_USAGE) }
}

/** Main's usage of one prompt on one model and effort; the tab counts main per prompt. */
const mainKey = (promptId: number, model: string, effort: AgentMonitorUsage['effort']) => `main:${promptId}:${model}:${effort ?? 'default'}`

/** Adds one main step to the session's usage, under the prompt it ran for. */
export const withMainStep = (
  state: AgentMonitorState,
  step: { model: string; effort?: AgentMonitorUsage['effort']; usd: number; tokens: number; isPriced: boolean },
): AgentMonitorState => {
  const id = mainKey(state.promptId ?? 0, step.model, step.effort)
  const usage = state.sessionAgents ?? []
  const before = usage.find(u => u.id === id) ?? { id, type: 'main', model: step.model, effort: step.effort, usd: 0, tokens: 0, isPriced: true }
  const after = { ...before, usd: before.usd + step.usd, tokens: before.tokens + step.tokens, isPriced: before.isPriced && step.isPriced }
  return { ...state, sessionAgents: [...usage.filter(u => u.id !== id), after].slice(-KEEP_USAGE) }
}

/** Main's usage during one prompt. */
export const mainUsageOf = (state: AgentMonitorState, promptId: number): AgentMonitorUsage[] =>
  (state.sessionAgents ?? []).filter(u => u.id.startsWith(`main:${promptId}:`))

/** One line of the Agents tab: how often a type ran on a model at an effort, and what that cost. */
export type UsageGroup = { label: string; count: number; usd: number; tokens: number; isPriced: boolean }

/** Groups agents by type, model and effort, in first-use order. */
export const groupUsage = (usage: AgentMonitorUsage[]): UsageGroup[] => {
  const groups = new Map<string, UsageGroup>()
  for (const u of usage) {
    const label = `${u.type} · ${u.model ?? '?'} · ${u.effort ?? 'default'}`
    const group = groups.get(label) ?? { label, count: 0, usd: 0, tokens: 0, isPriced: true }
    groups.set(label, {
      label,
      count: group.count + 1,
      usd: group.usd + u.usd,
      tokens: group.tokens + u.tokens,
      isPriced: group.isPriced && u.isPriced,
    })
  }
  return [...groups.values()]
}
