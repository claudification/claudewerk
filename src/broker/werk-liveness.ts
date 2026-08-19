/**
 * WHAT COUNTS AS LIVE, AND WHEN A UNIT OF WORK IS SETTLED -- for WERK, the one
 * unattended engine.
 *
 * WERK is a single runner with several TRIGGERS. Nightshift is the trigger that
 * scavenges its own work during the night window; an epic run is the trigger
 * that walks a board DAG. They are not two engines and never were
 * (plan-quest-engine.md:189).
 *
 * The two rules below were each written twice before this file existed --
 * `liveness()` in the epic sweep and an inline expression in the nightshift
 * guardians, with the epic copy's comment reading "Same rule as the nightshift
 * guardian" as if that were a coincidence rather than a duplication. They are
 * the rules the whole engine turns on, so a drift between them would mean one
 * trigger reaping work the other considers alive.
 */

import type { Conversation } from '../shared/protocol'

/** Liveness is the registry's to know; a caller supplies the predicate. */
export type IsLive = (conv: Conversation) => boolean

/**
 * THE LIVENESS RULE. A conversation is live unless it has ended AND holds no
 * socket.
 *
 * The socket half is not belt-and-braces: an `ended` conversation with an open
 * connection is mid-teardown, not settled, and treating it as settled is how a
 * unit of work gets a second seat while the first is still writing.
 */
export function werkLiveness(activeConnectionCount: (convId: string) => number): IsLive {
  return conv => conv.status !== 'ended' || activeConnectionCount(conv.id) > 0
}

/** One unit of work -- a card, a task -- and every conversation backing it. */
export interface WerkUnit {
  convs: Conversation[]
  /** True if ANY backing conversation is live. The OR is the whole point. */
  anyLive: boolean
}

/**
 * THE OR-FOLD. Group conversations by whatever identifies a unit of work, and
 * settle a unit only when NO conversation backing it is live.
 *
 * The OR is the subtle part and the reason this is a function rather than four
 * lines inlined twice: a unit retried after a crash has TWO conversations, and
 * last-write-wins would let the dead predecessor settle a unit that is being
 * actively worked right now.
 *
 * `key` returns null for a conversation this engine does not own, which is how
 * one pass over the whole registry serves a trigger that only cares about its
 * own tag.
 */
export function foldByWerkUnit(
  convs: readonly Conversation[],
  isLive: IsLive,
  key: (conv: Conversation) => string | null,
): Map<string, WerkUnit> {
  const units = new Map<string, WerkUnit>()
  for (const conv of convs) {
    const k = key(conv)
    if (k === null) continue
    const unit = units.get(k) ?? { convs: [], anyLive: false }
    unit.convs.push(conv)
    unit.anyLive = unit.anyLive || isLive(conv)
    units.set(k, unit)
  }
  return units
}

/**
 * The conversation that represents a settled unit's latest attempt -- the newest
 * ending, falling back to last activity for one that never recorded an end.
 *
 * Only meaningful on a unit where `anyLive` is false; on a live one the "latest
 * attempt" is whichever is still running, and the caller should be leaving it
 * alone rather than picking a representative.
 */
export function latestAttempt(unit: WerkUnit): Conversation | undefined {
  if (unit.convs.length === 0) return undefined
  return unit.convs.reduce((a, b) => ((b.endedBy?.at ?? b.lastActivity) > (a.endedBy?.at ?? a.lastActivity) ? b : a))
}
