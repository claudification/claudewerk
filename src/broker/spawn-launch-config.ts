/**
 * THE LAUNCH CONFIG ONE SPAWN PERSISTS -- pure, so what a spawn carries onto the
 * conversation record can be asserted without a sentinel, a store, or a socket.
 *
 * WHY THIS IS ITS OWN FILE AND NOT AN OBJECT LITERAL INSIDE THE DISPATCH:
 * EPIC MODE's seat tag was set by the spawn plan (`epic-spawn-plan.ts`), declared
 * on `LaunchConfig` as "mirrors `nightshift` exactly", and then silently dropped
 * here for the entire life of the feature -- because the assembly lived inside a
 * promise executor no test could reach. The engine consequently could not see a
 * single conversation it had spawned: zero seats, a lease pinned to a holder that
 * never existed, and the same card dispatched generation after generation.
 *
 * WERK TAGS ARE THE POINT. WERK is the one unattended engine and `nightshift` and
 * `epic` are two of its TRIGGERS, which is why one list serves both. `nightshift` and `epic` are how the broker later
 * recognises work it started itself. Dropping one does not fail loudly -- it makes
 * the owning engine blind, which is the most expensive shape a bug can take here.
 * Anything added to that family goes in `WERK_TAGS` below and is covered by the
 * round-trip test; a new tag copied by hand is the same bug again.
 */

import type { LaunchConfig } from '../shared/protocol'
import type { ResolvedSpawnConfig } from '../shared/spawn-defaults'
import type { SpawnRequest } from '../shared/spawn-schema'

/**
 * Translate the wire-level (`req.profile`, `req.pool`) pair into the persisted
 * `LaunchConfig.sentinelProfile` tagged union (INTENT). The intent round-trips
 * across revive + launch-profile save and feeds the conversation badge UX.
 *
 *  - Absent profile + absent pool   -> undefined (sentinel decides)
 *  - profile = literal name         -> { kind: 'profile', name }
 *                                       (pool is ignored when both are set)
 *  - pool = literal pool name       -> { kind: 'pool', name }
 *
 * Profile and pool are mutually exclusive at the intent layer. The wire accepts
 * both for ergonomics, but profile wins when both are present.
 */
function intentFromProfileField(profile?: string, pool?: string): LaunchConfig['sentinelProfile'] {
  if (profile) return { kind: 'profile', name: profile }
  if (pool) return { kind: 'pool', name: pool }
  return undefined
}

/**
 * Every WERK TAG a spawn request can carry onto the conversation. These are
 * markers the broker groups on later -- never capabilities. What a nightshift
 * task or an epic seat is ALLOWED to do is enforced by the settings the spawn
 * carried; nothing re-reads these to decide what an agent may do.
 *
 * Listed once, copied in a loop, and asserted as a SET by the round-trip test,
 * so adding a tag to `LaunchConfig` without wiring it here fails a test rather
 * than blinding whatever engine was going to read it back.
 */
export const WERK_TAGS = ['nightshift', 'epic'] as const

/** Copy the werk tags a request carries, dropping the absent ones. */
function werkTags(req: SpawnRequest): Pick<LaunchConfig, (typeof WERK_TAGS)[number]> {
  const out: Pick<LaunchConfig, (typeof WERK_TAGS)[number]> = {}
  for (const tag of WERK_TAGS) {
    if (req[tag] !== undefined) Object.assign(out, { [tag]: req[tag] })
  }
  return out
}

/**
 * Assemble the LaunchConfig persisted against a conversation at spawn time.
 *
 * `resolved` is `resolveSpawnConfig`'s output (explicit > profile > project >
 * global), and `appendSystemPrompt` arrives already composed because its stack
 * -- caller prompt, nightshift covenant, SOTU brief -- is decided at the dispatch
 * site where the project URI is known.
 */
export function buildLaunchConfig(
  req: SpawnRequest,
  resolved: ResolvedSpawnConfig,
  appendSystemPrompt: string | undefined,
): LaunchConfig {
  return {
    headless: resolved.headless,
    transport: resolved.transport,
    model: resolved.model,
    effort: resolved.effort,
    agent: resolved.agent,
    advisor: resolved.advisor,
    bare: resolved.bare || false,
    repl: resolved.repl || false,
    thinkingSummaries: resolved.thinkingSummaries,
    permissionMode: resolved.permissionMode,
    autocompactPct: resolved.autocompactPct,
    includePartialMessages: resolved.includePartialMessages,
    maxBudgetUsd: resolved.maxBudgetUsd,
    env: req.env || undefined,
    appendSystemPrompt,
    // Sentinel-profile INTENT (broker-safe NAME / mode / pool only). Profile env
    // stays sentinel-side (PROFILE-ENV BOUNDARY covenant).
    sentinelProfile: intentFromProfileField(req.profile, req.pool),
    ...werkTags(req),
  }
}
