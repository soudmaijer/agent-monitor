export type AgentMonitorEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

/** One loop: the main loop or a subagent. */
export type AgentMonitorRow = {
  /** The subagent's id; `main` for the main loop. */
  id: string
  /** The Agent tool call that spawned it, while its id is not yet known. */
  toolUseId?: string
  /** The id of the agent that spawned it; absent means the main loop. */
  parentId?: string
  description: string
  subagentType: string
  model?: string
  effort?: AgentMonitorEffort
  status: 'running' | 'done' | 'failed' | 'idle'
  /** This loop's own recent tool calls, newest last. */
  tasks: AgentMonitorTask[]
  /** Order of creation among all tasks and subagents, so a node lists its children as they happened. */
  seq: number
  /** Estimated spend of this loop's own requests since the last typed prompt. */
  usd: number
  tokens: number
  /** False once a request ran on a model with no listed price: tokens are shown instead of dollars. */
  isPriced: boolean
  /** What this loop's spend since the last typed prompt consists of. */
  breakdown?: AgentMonitorBreakdown
  startedAt: number
  endedAt?: number
}

/** A subagent as the Agents tab counts it: what it ran as, and what it cost. */
export type AgentMonitorUsage = {
  id: string
  type: string
  model?: string
  effort?: AgentMonitorEffort
  usd: number
  tokens: number
  isPriced: boolean
}

/** One tool call of the main loop. */
export type AgentMonitorTask = {
  id: string
  label: string
  seq: number
  status: 'running' | 'done' | 'failed'
  /** A text message the model wrote between its tool calls, not a tool call. */
  isText?: boolean
}

/** The spend and tokens of one kind of token. */
export type AgentMonitorCostPart = { usd: number; tokens: number }

/** What a loop's spend consists of: per kind of token, and its priciest requests. */
export type AgentMonitorBreakdown = {
  steps: number
  cacheWrite: AgentMonitorCostPart
  cacheRead: AgentMonitorCostPart
  output: AgentMonitorCostPart
  input: AgentMonitorCostPart
  /** The priciest requests, priciest first, each with what it did. */
  top: { usd: number; label: string }[]
}

/** What one prompt's main turns or one subagent cost in the session. */
export type AgentMonitorCost = {
  /** `prompt:<promptId>` or `agent:<id>`. */
  key: string
  label: string
  usd: number
  tokens: number
  isPriced: boolean
  breakdown?: AgentMonitorBreakdown
}

/** An earlier prompt as it stood when the next typed prompt replaced it. */
export type AgentMonitorSnapshot = {
  prompt: string
  main: AgentMonitorRow
  agents: AgentMonitorRow[]
  promptSkills: string[]
  promptRules: string[]
  /** The session's cost when the prompt was submitted, and when the next one replaced it. */
  /** The prompt's id, so the Agents tab finds main's usage of that prompt. */
  promptId?: number
  startUsd: number
  endUsd: number
}

export type AgentMonitorCache = {
  expiresAt: number
  ttlMs: number
  /** False while the TTL is assumed, true once a request after a pause showed it. */
  isMeasured: boolean
}

export type AgentMonitorState = {
  /** Earlier typed prompts, oldest first; the last few only. */
  history?: AgentMonitorSnapshot[]
  /** The last typed prompt, whitespace collapsed; empty before the first. */
  prompt: string
  /** Prompts typed while main was still working on `prompt`, oldest first; shown until that turn ends. */
  queuedPrompts?: string[]
  /** The session's exact cost so far, from `$.session.usage()`. */
  sessionUsd?: number
  /** The session's cost when the last typed prompt was submitted; the prompt's cost is the difference. */
  promptStartUsd?: number
  /** Skills invoked since the last typed prompt, and in the whole session, one entry per invocation. */
  promptSkills?: string[]
  /** Main's prompt cache: when it is estimated to go cold (its last request, or a fork's, plus the TTL), and the TTL used. */
  cache?: AgentMonitorCache
  /** How full the context window is, 0 to 100, as of the last cost refresh. */
  contextPercent?: number
  sessionSkills?: string[]
  /** Rules loaded since the last typed prompt, and in the whole session, each once. */
  promptRules?: string[]
  sessionRules?: string[]
  /** Where each skill and rule seen lives, by name: a skill's folder, a rule's file. */
  skillPaths?: Record<string, string>
  rulePaths?: Record<string, string>
  /** Counts the typed prompts, so each prompt's main cost has its own entry. */
  promptId?: number
  /** The session's most expensive prompts and subagents, most expensive first. */
  topCosts?: AgentMonitorCost[]
  /** The session's working folder, which the shown paths are relative to. */
  cwd?: string
  /** Every subagent of the session, the last 200; `agents` keeps the current prompt's only. */
  sessionAgents?: AgentMonitorUsage[]
  main: AgentMonitorRow
  /** The last `seq` handed out. */
  seq: number
  agents: AgentMonitorRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { monitor: Shaped<AgentMonitorState>; tick: Shaped<number>; footerTab: Shaped<'cost' | 'skills' | 'agents' | 'rules'>; viewing: Shaped<number>; expanded: Shaped<string[]> }
  }
}
