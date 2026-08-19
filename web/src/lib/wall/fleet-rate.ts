/**
 * P4's rate maths, kept OUT of React so the one number on the wall that is
 * easiest to get subtly wrong can be tested without a DOM.
 *
 * TWO-MINUTE BUCKETS, not one. `token-flow-store` seeds its ring from the
 * server's 2-minute aggregates, each landing as ONE synthetic sample at its
 * bucket start. Bucketing finer than that piles a whole 2 minutes of tokens into
 * a single 60s slot and leaves the next one empty -- the store says so itself and
 * the header widget obeys the same rule. So the bucket matches the seed
 * granularity and the rate is divided back down to per-minute.
 *
 * THE TRAILING BUCKET IS DROPPED. The bucket containing `now` is still filling:
 * publishing it as a rate shows a number that climbs for two minutes and then
 * falls off a cliff, which reads as a fleet going quiet when nothing happened.
 * Only complete buckets are a rate.
 */

import { bucketize, type FlowBucket, type TokenSample, windowEdges } from '@/hooks/token-flow-store'

/** Matches the seed granularity of `/api/stats/tokens?window=2h`. */
export const RATE_BUCKET_MS = 120_000
/** Complete buckets kept for the sparkline. 15 x 2min = the last half hour. */
export const RATE_BUCKETS = 15

export interface TokenRate {
  /** Complete buckets only, oldest first. Empty when nothing has been sampled. */
  buckets: FlowBucket[]
  /**
   * Tokens per minute over the last COMPLETE bucket, or null when the ring holds
   * no sample at all -- the "no feed" case the pane must render as a dash rather
   * than as a confident zero.
   */
  perMinute: number | null
}

/** input + output. Cache reads dwarf both and are the cheapest thing on the
 *  wire, so counting them here would make the rate a cache-hit meter. */
function moved(b: FlowBucket): number {
  return b.input + b.output
}

export function tokenRate(samples: readonly TokenSample[], now: number): TokenRate {
  if (samples.length === 0) return { buckets: [], perMinute: null }
  // One extra bucket is asked for and then dropped: the one straddling `now`.
  const windowMs = (RATE_BUCKETS + 1) * RATE_BUCKET_MS
  const { from, to } = windowEdges(now, windowMs, RATE_BUCKET_MS)
  // Synthetic seed samples ARE included: this bucket width is exactly the
  // granularity they were aggregated at, which is the store's own condition.
  const all = bucketize(samples, from, to, RATE_BUCKET_MS, { includeSynthetic: true })
  // Drop the bucket that CONTAINS `now`. When `now` lands exactly on a bucket
  // boundary there is no such bucket in the window (`windowEdges` rounded to
  // `now` itself), and dropping one anyway would throw away a complete reading.
  // The tail slice then keeps the length fixed either way.
  const buckets = (to > now ? all.slice(0, -1) : all).slice(-RATE_BUCKETS)
  const last = buckets.at(-1)
  return { buckets, perMinute: last ? moved(last) / (RATE_BUCKET_MS / 60_000) : null }
}
