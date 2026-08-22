/**
 * THE WERK-MASTER LEASE, AS A SENTENCE -- shared by the wall's A7 row and the
 * werk-master window.
 *
 * It lived in `components/wall/runs/run-model.ts`, which made it the wall's
 * private property. The werk-master window therefore had no lease reading at all:
 * it collapsed the whole thing to `leaseHeld={Boolean(data.lease?.convId)}` and
 * showed live werk-master CONVERSATIONS beside it -- a different fact, which the
 * engine is careful to keep apart (`holderIsAlive` in epic-beat-actions.ts) and
 * the panel was not.
 *
 * The cost of that was concrete on 2026-08-20: the lease named `0dc1e780` at
 * generation 11 with no live conversation, which is the entire explanation of
 * why the run was deadlocked, and the window could only say "held: yes".
 */

import type { EpicLease } from '@shared/epic-lease'
import { formatDurationShort } from '@/lib/status-style'

/**
 * MIRRORS `LEASE_STALE_MS` in `src/shared/epic-lease.ts`, which cannot be
 * imported here: that module pulls `node:path` through `epic-paths.ts` and would
 * drag it into the browser bundle. Same number, same meaning -- a holder this old
 * is presumed dead however alive its conversation claims to be.
 */
export const LEASE_STALE_MS = 10 * 60 * 1000

export type LeaseKind =
  /** The epic has never had a werk-master. */
  | 'never'
  /** One woke and released the grip cleanly. */
  | 'released'
  /** Held by a conversation that is alive and recent. */
  | 'held'
  /** Held by something dead, or held far too long. THE alarm. */
  | 'stale'

export interface LeaseState {
  kind: LeaseKind
  /** How long the current holder has held it. */
  sinceMs: number | null
  /** Short form of the holding conversation id, for the sentence. */
  holder: string
  gen: number
}

export function leaseState(lease: EpicLease | null, werkMasterAlive: boolean, nowMs: number): LeaseState {
  if (!lease) return { kind: 'never', sinceMs: null, holder: '', gen: 0 }

  const taken = lease.at ? Date.parse(lease.at) : Number.NaN
  const sinceMs = Number.isFinite(taken) ? Math.max(0, nowMs - taken) : null
  const base = { sinceMs, holder: lease.convId.slice(0, 8), gen: lease.gen }

  // Released is a FACT, not an absence: the generation counter survives a
  // release, so an empty holder with a generation means it ran and let go.
  if (!lease.convId) return { ...base, kind: 'released' }

  // A holder whose conversation is gone is the 2026-08-18 failure verbatim: the
  // run keeps its grip, the next wake's CAS keeps losing, and nothing says so.
  const dead = !werkMasterAlive
  const ancient = sinceMs === null || sinceMs > LEASE_STALE_MS
  return { ...base, kind: dead || ancient ? 'stale' : 'held' }
}

/** The lease, as one sentence. `stale` is the only one that raises its voice.
 *  Every branch names the GENERATION, because the generation is what the wake's
 *  compare-and-swap actually argues with. */
export function leaseSentence(lease: LeaseState): string {
  const age = lease.sinceMs === null ? 'unknown age' : `${formatDurationShort(lease.sinceMs)} ago`
  if (lease.kind === 'never') return 'werk-master has never woken'
  if (lease.kind === 'released') return `werk-master released the lease at gen ${lease.gen}`
  if (lease.kind === 'stale') return `STALE LEASE -- ${lease.holder} has held gen ${lease.gen} since ${age}`
  return `werk-master ${lease.holder} woke ${age} and holds gen ${lease.gen}`
}
