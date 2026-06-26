/**
 * SOTU contribution queue -- append-only JSONL (Layer 1).
 *
 * The queue is the free, no-LLM substrate: every contribution (callout,
 * turn-digest, git-scan, lifecycle) is one line of JSON. Appending is the only
 * mutation; the scribe/reconcile fold (Phase 4) drains + decays it. Reading the
 * non-expired entries alone yields the live soft-lock map for zero LLM cost.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { queuePath } from './paths'
import type { Contribution } from './types'

/** Append one contribution as a JSONL line. Append-only -- never rewrites. */
export function appendContribution(slug: string, contrib: Contribution): void {
  appendFileSync(queuePath(slug), `${JSON.stringify(contrib)}\n`)
}

/** Read every contribution in append order. Malformed lines are skipped (a
 *  partial line from a crash mid-append must not poison the whole read). */
export function readQueue(slug: string): Contribution[] {
  const p = queuePath(slug)
  if (!existsSync(p)) return []
  const out: Contribution[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line) as Contribution)
    } catch {
      // skip a torn/partial line -- never throw on a poisoned queue
    }
  }
  return out
}

/** Whether a contribution has expired by `now` (ts + ttlMs in the past).
 *  Entries with no ttlMs never expire. */
export function isExpired(contrib: Contribution, now: number): boolean {
  return contrib.ttlMs !== undefined && contrib.ts + contrib.ttlMs < now
}

/** The live soft-lock map input: contributions whose ttl has not elapsed.
 *  This is the always-on, zero-LLM read. */
export function readLiveQueue(slug: string, now: number): Contribution[] {
  return readQueue(slug).filter(c => !isExpired(c, now))
}
