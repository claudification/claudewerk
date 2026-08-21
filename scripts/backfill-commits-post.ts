/**
 * The NETWORK side of the commit backfill: push payloads at `/api/commits` with
 * a bounded number in flight, and count what actually happened.
 *
 * Separate from the CLI because it is the half with a failure mode. The ingest
 * answers 202 for a row it wrote and 200 for one it already had, and those two
 * mean very different things to whoever reads the run's output -- "13,000
 * duplicates" on a first run is a bug, not a success.
 */

import type { CommitIngestPayload } from '../src/shared/commit-ledger'

export interface BackfillTally {
  inserted: number
  duplicate: number
  failed: number
}

export interface PostOptions {
  origin: string
  secret: string
  concurrency: number
}

/**
 * Accepts the same two spellings the post-commit hook does: an agent host hands
 * out an http(s) origin, a sentinel hands out a `wss://` one. REST needs
 * http(s), so normalize rather than demand a second variable.
 */
export function resolveBrokerOrigin(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  if (!trimmed) return 'http://localhost:9999'
  return trimmed.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
}

// RULED: CRAP-only, on estimated coverage. Six branches, and five of them are
// the distinct HTTP outcomes this function exists to tell apart (202 written,
// 200 duplicate, other status, throw, and the error-log cap). Collapsing them is
// exactly the silent-partial-backfill failure the tally exists to prevent.
// fallow-ignore-next-line complexity
async function postOne(payload: CommitIngestPayload, opts: PostOptions, tally: BackfillTally): Promise<void> {
  try {
    const res = await fetch(`${opts.origin}/api/commits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.secret}` },
      body: JSON.stringify(payload),
    })
    // 202 = written, 200 = the ledger already had it. Anything else is a loss.
    if (res.status === 202) tally.inserted++
    else if (res.status === 200) tally.duplicate++
    else {
      tally.failed++
      if (tally.failed <= 3) console.error(`  ! ${payload.hash?.slice(0, 8)} -> HTTP ${res.status} ${await res.text()}`)
    }
  } catch (err) {
    tally.failed++
    if (tally.failed <= 3) console.error(`  ! ${payload.hash?.slice(0, 8)} -> ${String(err)}`)
  }
}

/**
 * A fixed pool of workers draining one shared cursor, rather than chunked
 * batches: a batch barrier would idle the whole pool waiting on its slowest
 * request, and these are thousands of tiny writes to one SQLite file where the
 * latency spread is exactly what you would expect it to be.
 */
export async function postCommits(payloads: readonly CommitIngestPayload[], opts: PostOptions): Promise<BackfillTally> {
  const tally: BackfillTally = { inserted: 0, duplicate: 0, failed: 0 }
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < payloads.length) {
      const payload = payloads[cursor++]
      if (payload) await postOne(payload, opts, tally)
    }
  }
  const size = Math.max(1, Math.min(opts.concurrency, payloads.length))
  await Promise.all(Array.from({ length: size }, worker))
  return tally
}
