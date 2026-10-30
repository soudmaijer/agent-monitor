import type { AgentMonitorRow } from '../types'

const FALLBACK_DURATION_MS = 60_000
const RUNNING_CAP = 0.95

export const bar = (fraction: number, width: number): string => {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Subagents finished (done or failed) against subagents seen, e.g. `{ done: 4, total: 6 }`. */
export const countAgents = (agents: AgentMonitorRow[]) => ({
  done: agents.filter(a => a.status === 'done' || a.status === 'failed').length,
  total: agents.length,
})

/** Tasks finished (done or failed) against all tasks of main and every subagent, e.g. `{ done: 7, total: 9 }`. */
export const countTasks = (main: AgentMonitorRow, agents: AgentMonitorRow[]) => {
  const tasks = [main, ...agents].flatMap(row => row.tasks).filter(t => !t.isText)
  return {
    done: tasks.filter(t => t.status === 'done' || t.status === 'failed').length,
    total: tasks.length,
  }
}

/** Everything the pane tracks, finished against all: the tasks of main and every subagent, and the subagents themselves. */
export const countProgress = (main: AgentMonitorRow, agents: AgentMonitorRow[]) => {
  const tasks = countTasks(main, agents)
  const subagents = countAgents(agents)
  return {
    done: tasks.done + subagents.done,
    total: tasks.total + subagents.total,
    runningAgents: agents.filter(a => a.status === 'running').length,
  }
}

/** The average duration of the finished subagents, or a fallback when none finished. */
export const expectedDurationMs = (agents: AgentMonitorRow[]): number => {
  const durations = agents
    .filter(a => a.status === 'done' && a.endedAt !== undefined)
    .map(a => (a.endedAt ?? 0) - a.startedAt)
  if (durations.length === 0) return FALLBACK_DURATION_MS
  return Math.max(1, durations.reduce((sum, d) => sum + d, 0) / durations.length)
}

/** How far along a subagent is: full when done, an estimate capped below full while running. */
export const progressOf = (row: AgentMonitorRow, expectedMs: number, now: number): number => {
  if (row.status !== 'running') return 1
  return Math.min(RUNNING_CAP, Math.max(0, now - row.startedAt) / expectedMs)
}
