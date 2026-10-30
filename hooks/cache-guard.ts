import { CACHE_TTL_MS, PRICES, writeFactorOf } from './pricing'
import type { StepUsage } from './pricing'

/** A predicted cache rewrite above this many USD asks the person first. */
export const APPROVAL_USD = 2

export const SHORT_TTL_MS = 5 * 60 * 1000
export const LONG_TTL_MS = 60 * 60 * 1000

/** What the guard remembers of a loop's last request; `at` is when the request started. */
export type LastStep = { at: number; model: string; effort?: string | number; contextTokens: number }

/** The cache TTL in use: assumed until a request after a pause shows which one it is. */
export type CacheTtl = { ms: number; isMeasured: boolean }

export const ASSUMED_TTL: CacheTtl = { ms: CACHE_TTL_MS, isMeasured: false }

export const contextTokensOf = (usage: StepUsage): number =>
  usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

/** Most of the previous context came from the cache. */
const isHit = (usage: StepUsage, previousTokens: number) => usage.cache_read_input_tokens >= previousTokens / 2

/** Almost none of the previous context came from the cache. */
const isMiss = (usage: StepUsage, previousTokens: number) => usage.cache_read_input_tokens < previousTokens / 10

/**
 * What a request after a pause says about the TTL. Only a request on the same model
 * and effort counts, since a change of either makes the cache cold by itself: a hit
 * after more than 5 minutes means the 1 hour TTL, a miss after a pause the 1 hour
 * TTL would have survived means the 5 minute one.
 */
export const measureTtl = (ttl: CacheTtl, last: LastStep, step: LastStep, usage: StepUsage): CacheTtl => {
  if (!sameModel(last.model, step.model) || last.effort !== step.effort) return ttl
  const pauseMs = step.at - last.at
  if (pauseMs <= SHORT_TTL_MS) return ttl
  if (isHit(usage, last.contextTokens)) return { ms: LONG_TTL_MS, isMeasured: true }
  if (pauseMs < LONG_TTL_MS && isMiss(usage, last.contextTokens)) return { ms: SHORT_TTL_MS, isMeasured: true }
  return ttl
}

/**
 * A subagent's first request that reads most of main's context from the cache starts
 * with main's prefix, as a fork does: its requests keep main's cache warm.
 */
export const sharesPrefix = (main: LastStep, step: LastStep, usage: StepUsage): boolean =>
  sameModel(main.model, step.model) && main.contextTokens > 0 && isHit(usage, main.contextTokens)

/** Why the cache will be cold for the next request, or undefined while it is warm. */
export const coldReason = (
  last: LastStep,
  step: { model: string; effort?: string | number },
  ttlMs: number,
  now: number,
): string | undefined => {
  if (!sameModel(last.model, step.model)) return `model changes from ${last.model} to ${step.model}`
  // Effort is rendered into the prompt: changing it invalidates the messages cache.
  if (last.effort !== step.effort) return `effort changes from ${last.effort ?? 'default'} to ${step.effort ?? 'default'}`
  const idleMs = now - last.at
  if (idleMs > ttlMs) return `cache expired (${Math.round(idleMs / 60_000)} min idle)`
  return undefined
}

/** The predicted cost of writing the whole context to the cache again, or undefined for an unpriced model. */
export const rewriteUsd = (contextTokens: number, model: string, ttlMs: number): number | undefined => {
  const id = model.toLowerCase().replace(/\./g, '-')
  const price = PRICES.find(row => id.includes(row.match))?.price
  if (!price) return undefined
  return (contextTokens * price.input * writeFactorOf(ttlMs)) / 1_000_000
}

/**
 * A fork's request starts with its parent's whole context, so on the same model it
 * keeps the parent's cache warm too: the parent's last step moves up to `at`.
 */
export const warmedByFork = (parent: LastStep, model: string, at: number): LastStep =>
  sameModel(parent.model, model) && at > parent.at ? { ...parent, at } : parent

// An alias (`opus`) and the full id it resolves to name the same model.
const sameModel = (a: string, b: string) => {
  const x = a.toLowerCase().replace(/\./g, '-')
  const y = b.toLowerCase().replace(/\./g, '-')
  return x === y || x.includes(y) || y.includes(x)
}
