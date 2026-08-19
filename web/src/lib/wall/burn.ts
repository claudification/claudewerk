/**
 * THE BURN CLOCK's live half: dollars per hour, measured from what the wall
 * channel already carries.
 *
 * WHY A FOLD AND NOT A POLL. There is no cost section on the `wall` frame and
 * there is no "current burn rate" endpoint. What there IS is `WallPulseRow.costUsd`
 * -- each conversation's own running total, sent at ~2 Hz on a socket the wall
 * already holds. The difference between two frames IS money spent, timestamped by
 * the broker. Folding those deltas is therefore a MEASUREMENT, not an estimate:
 * every dollar in this number came off a conversation that actually billed it.
 *
 * ONLY UPWARD DELTAS COUNT, and a conversation is SEEDED on first sighting rather
 * than accrued. Both rules exist for the same reason: the map behind the pulse
 * section is latest-value-wins over a roster that changes. A conversation that
 * ends and drops out must not read as a refund, and a conversation that appears
 * carrying six hours of history must not read as six hours of spend in one tick.
 *
 * A GAP RESEEDS. Frames stop while the socket is down, so the first frame after a
 * reconnect carries every cost that accrued in the dark. Charging that to the
 * instant it arrived would spike a ten-minute rate by an hour of spending. Past
 * `BURN_STALL_MS` the fold reseeds instead and the window starts again -- the
 * pane would rather say "still measuring" than say a number it made up.
 */

/** The rolling window the live rate is measured over. Long enough that one
 *  expensive turn does not own the number, short enough to still read as "now". */
export const BURN_WINDOW_MS = 10 * 60_000

/** Below this much observation there is no rate, only a dash. A wall opened five
 *  seconds ago has seen five seconds of spending and cannot divide it into an
 *  hour without inventing the other 59 minutes and 55 seconds. */
export const BURN_MIN_OBSERVED_MS = 60_000

/** Sparkline resolution. 20 buckets across `BURN_WINDOW_MS`. */
const BURN_BUCKET_MS = 30_000

/** No frame for this long means we were not watching, so what arrives next is
 *  history rather than a delta. Frames come at ~2 Hz; this is 120 missed ones. */
export const BURN_STALL_MS = 60_000

/** The fields the fold reads off a `WallPulseRow`. Deliberately structural: the
 *  maths does not need the other fourteen. */
export interface BurnCostRow {
  id: string
  costUsd?: number
}

/** One observed accrual, at the broker clock that observed it. */
export interface BurnSample {
  at: number
  usd: number
}

/** The fold's whole memory. Held in a ref by the component that folds. */
export interface BurnAccrual {
  /** Last total seen per conversation. First sighting seeds, never accrues. */
  seen: Map<string, number>
  /** Oldest first, pruned to `BURN_WINDOW_MS`. Sparse: silence costs nothing. */
  samples: BurnSample[]
  /** Broker clock of the first frame in the current observation. 0 = nothing yet. */
  since: number
  /** Broker clock of the last frame folded, for the stall check. */
  lastAt: number
}

export function emptyAccrual(): BurnAccrual {
  return { seen: new Map(), samples: [], since: 0, lastAt: 0 }
}

/**
 * Fold one frame's pulse rows. Returns the dollars this frame accrued, which is
 * 0 on the seeding frame and 0 again whenever nothing moved.
 *
 * Mutates `acc` on purpose: it is per-component state living in a ref, folded at
 * 2 Hz, and copying a Map of the whole fleet twice a second to look pure would
 * be a cost with no reader.
 */
export function foldBurnFrame(acc: BurnAccrual, rows: readonly BurnCostRow[], at: number): number {
  const stalled = acc.lastAt > 0 && at - acc.lastAt > BURN_STALL_MS
  if (stalled) {
    // Reseed: what these rows carry now includes whatever happened while the
    // socket was down, and that money has no honest timestamp.
    acc.seen.clear()
    acc.samples = []
    acc.since = 0
  }
  const seeding = acc.since === 0
  if (seeding) acc.since = at
  acc.lastAt = at

  let accrued = 0
  for (const row of rows) {
    const cost = row.costUsd
    if (cost === undefined || !Number.isFinite(cost)) continue
    const prev = acc.seen.get(row.id)
    acc.seen.set(row.id, cost)
    if (prev === undefined) continue
    const delta = cost - prev
    if (delta > 0) accrued += delta
  }

  if (accrued > 0) acc.samples.push({ at, usd: accrued })
  pruneAccrual(acc, at)
  return accrued
}

/** Drop samples that fell out of the window. Called on every fold so the ring
 *  cannot grow on a wall left open overnight. */
function pruneAccrual(acc: BurnAccrual, now: number): void {
  const cutoff = now - BURN_WINDOW_MS
  if (acc.samples.length > 0 && (acc.samples[0]?.at ?? 0) < cutoff) {
    acc.samples = acc.samples.filter(s => s.at >= cutoff)
  }
}

/** What the pane renders. `usdPerHour: null` is the dash -- not enough observed. */
export interface BurnReading {
  /** Dollars per hour over the observed window, or null when it is too short. */
  usdPerHour: number | null
  /** How long we have actually been watching, capped at the window. */
  observedMs: number
  /** Dollars accrued inside the window. Real, even when the rate is null. */
  windowUsd: number
}

/**
 * The rate, over however much of the window we have genuinely observed.
 *
 * The divisor is OBSERVED time, never the nominal window: a wall open for two
 * minutes divides two minutes of spending by two minutes, not by ten. Using the
 * window would quietly report a fifth of the truth for the first eight minutes.
 */
export function burnReading(acc: BurnAccrual, now: number): BurnReading {
  const observedMs = acc.since === 0 ? 0 : Math.min(Math.max(0, now - acc.since), BURN_WINDOW_MS)
  const cutoff = now - BURN_WINDOW_MS
  let windowUsd = 0
  for (const s of acc.samples) if (s.at >= cutoff) windowUsd += s.usd
  if (observedMs < BURN_MIN_OBSERVED_MS) return { usdPerHour: null, observedMs, windowUsd }
  return { usdPerHour: windowUsd / (observedMs / 3_600_000), observedMs, windowUsd }
}

/**
 * The sparkline: dollars per bucket, oldest first, zero-filled to a fixed length.
 *
 * Zero-filled rather than sparse because a gap in spending is a FACT the chart
 * should show. A sparse series would draw two expensive minutes as a continuous
 * plateau across the quiet eight between them.
 */
export function burnSparkline(acc: BurnAccrual, now: number, bucketMs: number = BURN_BUCKET_MS): number[] {
  const count = Math.max(1, Math.round(BURN_WINDOW_MS / bucketMs))
  const buckets = new Array<number>(count).fill(0)
  const start = now - count * bucketMs
  for (const s of acc.samples) {
    const idx = Math.floor((s.at - start) / bucketMs)
    if (idx < 0 || idx >= count) continue
    buckets[idx] = (buckets[idx] ?? 0) + s.usd
  }
  return buckets
}
