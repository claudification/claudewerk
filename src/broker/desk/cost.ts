/**
 * Cost-awareness for dispatch routing (plan-dispatcher-build.md §9.2).
 *
 * Jonas: "needs an idea of what EXPENSIVE agents are.. opus, VERY FUCKING
 * expensive.. a conversation with > 150k context and timed out cache; VERY
 * VERY EXPENSIVE.. but sometimes if the user insists, should be considered,
 * with a confirmation."
 *
 * Metrics come off the EXISTING Conversation record (contextTokens / idleMs /
 * model) -- status-tool does NOT re-emit them. This module turns those numbers
 * into a `DispatchCostSignal` (a scoring penalty + the confirmation-gate input).
 *
 * Thresholds reuse Front Desk D18-D20:
 *   - idle past the Anthropic 5-min cache TTL -> a resume re-pays full context.
 *     We treat >23 min idle as a COLD cache (the D18 soft-penalty boundary).
 *   - >150k context tokens -> very expensive (D19).
 *   - Opus is intrinsically expensive regardless of size.
 */

import type { DispatchCostSignal } from '../../shared/protocol'

export const CACHE_TTL_COLD_MS = 23 * 60 * 1000 // D18: past this, resume re-pays context
const CTX_VERY_EXPENSIVE = 150_000 // D19
const CTX_EXPENSIVE = 90_000
const CTX_MODERATE = 40_000

export interface CostInput {
  /** Summed input/cache context tokens on the conversation, if known. */
  contextTokens?: number
  /** ms since last activity, if known. */
  idleMs?: number
  /** Model/profile name, e.g. 'opus', 'claude-opus-4-8', 'haiku'. */
  model?: string
}

function isOpus(model: string | undefined): boolean {
  return !!model && /opus/i.test(model)
}

/** Order tiers so we can take the max of several signals. */
const TIER_RANK: Record<DispatchCostSignal['tier'], number> = {
  cheap: 0,
  moderate: 1,
  expensive: 2,
  very_expensive: 3,
}
const RANK_TIER = ['cheap', 'moderate', 'expensive', 'very_expensive'] as const

function maxTier(a: DispatchCostSignal['tier'], b: DispatchCostSignal['tier']): DispatchCostSignal['tier'] {
  return RANK_TIER[Math.max(TIER_RANK[a], TIER_RANK[b])]
}

/**
 * Compute the cost signal for resuming/routing into a conversation (or for a
 * fresh spawn, where only `model` is known). Pure -- no I/O.
 */
export function computeCostSignal(input: CostInput): DispatchCostSignal {
  const ctx = input.contextTokens ?? 0
  const coldCache = (input.idleMs ?? 0) > CACHE_TTL_COLD_MS
  const opus = isOpus(input.model)

  let tier: DispatchCostSignal['tier'] = 'cheap'
  if (ctx >= CTX_VERY_EXPENSIVE) tier = 'very_expensive'
  else if (ctx >= CTX_EXPENSIVE) tier = 'expensive'
  else if (ctx >= CTX_MODERATE) tier = 'moderate'

  // A cold cache on a non-trivial context bumps the tier -- the resume re-pays
  // to re-warm everything.
  if (coldCache && ctx >= CTX_EXPENSIVE) tier = 'very_expensive'
  else if (coldCache && ctx >= CTX_MODERATE) tier = maxTier(tier, 'expensive')

  // Opus is expensive intrinsically; never read below 'expensive'.
  if (opus) tier = maxTier(tier, 'expensive')

  const signal: DispatchCostSignal = { tier }
  if (input.contextTokens !== undefined) signal.contextTokens = input.contextTokens
  if (input.idleMs !== undefined) signal.idleMs = input.idleMs
  if (coldCache) signal.coldCache = true
  if (input.model !== undefined) signal.model = input.model
  signal.note = buildNote({ ctx, coldCache, opus, tier })
  return signal
}

function buildNote(p: { ctx: number; coldCache: boolean; opus: boolean; tier: DispatchCostSignal['tier'] }): string {
  const parts: string[] = []
  if (p.opus) parts.push('Opus')
  if (p.ctx >= CTX_MODERATE) parts.push(`${Math.round(p.ctx / 1000)}k context`)
  if (p.coldCache) parts.push('cold cache (resume re-pays context)')
  if (parts.length === 0) return 'cheap: small context, warm'
  return `${p.tier.replace('_', ' ')}: ${parts.join(', ')}`
}

/** Does routing into this cost tier require an explicit user confirmation? */
export function requiresConfirmation(cost: DispatchCostSignal | undefined): boolean {
  return cost?.tier === 'very_expensive'
}
