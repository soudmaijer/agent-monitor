import type { AgentMonitorCost } from '../types'
/** Token counts of one model request, as `turn.step` reports them. */
export type StepUsage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** USD per million tokens. */
type Price = { input: number; output: number; cacheRead: number }

/**
 * Per-token prices, matched by substring of the model id (dots read as dashes),
 * first match wins, so a longer id sits above its shorter prefix.
 *
 * Source: the claude-api skill's "Current Models" table (cached 2026-10-06) and
 * its per-model notes: input and output prices for every row; cache-read prices
 * stated for Opus 5.5 ($0.20), Sonnet 5.5 and 5 ($0.20) and Fable 5.1 ($0.25).
 * Where the skill states no cache-read price the rule it does state is used:
 * cache reads cost 0.1x the input price. Cache writes cost 1.25x the input price
 * (the 5 minute cache), also from the skill. Haiku 5.5's prices hold for prompts
 * up to 100K tokens. These are estimates; only the session total is exact.
 */
export const PRICES: { match: string; price: Price }[] = [
  { match: 'fable', price: { input: 10, output: 50, cacheRead: 0.25 } },
  { match: 'mythos', price: { input: 10, output: 50, cacheRead: 0.25 } },
  { match: 'opus-5-5', price: { input: 4, output: 20, cacheRead: 0.2 } },
  { match: 'opus-5', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { match: 'opus-4-8', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { match: 'opus-4-7', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { match: 'opus-4-6', price: { input: 5, output: 25, cacheRead: 0.5 } },
  { match: 'sonnet-5', price: { input: 2, output: 10, cacheRead: 0.2 } },
  { match: 'sonnet-4-6', price: { input: 3, output: 15, cacheRead: 0.3 } },
  { match: 'haiku-5-5', price: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
  { match: 'haiku-4-5', price: { input: 1, output: 5, cacheRead: 0.1 } },
]

/**
 * How long the prompt cache stays warm, counted from the start of the last request
 * that read or wrote it. Claude Code picks it per request and does not pass it to a
 * mod: 1 hour in this setup, 5 minutes once usage goes into overage.
 */
export const CACHE_TTL_MS = 60 * 60 * 1000

const priceOf = (model: string): Price | undefined => {
  const id = model.toLowerCase().replace(/\./g, '-')
  return PRICES.find(row => id.includes(row.match))?.price
}

/** A cache write costs 1.25x the input price for the 5 minute TTL and 2x for the 1 hour TTL. */
export const writeFactorOf = (ttlMs: number) => (ttlMs > 5 * 60 * 1000 ? 2 : 1.25)

/** The estimated USD cost of one request whose cache writes run on `ttlMs`, or undefined for a model with no listed price. */
export const costOf = (usage: StepUsage, ttlMs: number): number | undefined => {
  const price = priceOf(usage.model)
  if (!price) return undefined
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_read_input_tokens * price.cacheRead +
      usage.cache_creation_input_tokens * price.input * writeFactorOf(ttlMs)) /
    1_000_000
  )
}

export const totalTokens = (usage: StepUsage): number =>
  usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

export const formatUsd = (usd: number): string => (usd > 0 && usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`)

export const formatTokens = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M tok` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k tok` : `${tokens} tok`

/** What a node shows for its spend: dollars, or tokens once any of its models had no price; empty when nothing ran. */
export const formatSpend = (spend: { usd: number; tokens: number; isPriced: boolean }): string =>
  spend.tokens === 0 ? '' : spend.isPriced ? formatUsd(spend.usd) : formatTokens(spend.tokens)

const TOP_COSTS = 10

/** Puts a loop's spend so far into the ranking, replacing its earlier entry, and keeps the top ten. */
export const rankCost = (top: AgentMonitorCost[] = [], entry: AgentMonitorCost): AgentMonitorCost[] =>
  [...top.filter(c => c.key !== entry.key), entry]
    .filter(c => c.tokens > 0)
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens)
    .slice(0, TOP_COSTS)
