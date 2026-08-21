/**
 * THE BURN CLOCK's historical half: totals, the two splits, and the cap state.
 *
 * THE TWO SPLITS ARE NEVER SUMMED, and this file is where that is enforced
 * rather than merely intended. Each split gets its own `total` and its own
 * shares, computed from its own rows, so there is no expression anywhere that
 * could add a project's dollars to a feature's. They are different currencies of
 * attention: the project split is work done FOR something, the OpenRouter split
 * is the panel's own infrastructure billing itself. One bar chart holding both
 * would answer a question nobody asked.
 *
 * Every number here comes from a broker aggregation that already existed
 * (`store.costs` for the Anthropic side, `openrouter-spend-store` for the
 * OpenRouter side). Nothing in this file estimates: a missing feed is `null` all
 * the way to a dash, never a plausible zero.
 */

/** The three fields the burn maths reads off an `/api/stats/hourly` row. */
export interface BurnHourlyRow {
  /** `2026-08-20T14:00:00Z` -- the bucket START, UTC, as the cost store writes it. */
  hour: string
  projectUri: string
  costUsd: number
}

/** One bar in a split. `share` is of THIS split's total and no other. */
export interface BurnBar {
  key: string
  label: string
  costUsd: number
  /** 0-1, of this split's own total. */
  share: number
}

/** A split, kept whole so a renderer cannot accidentally be handed two of them
 *  merged. `total` is the sum of `bars` and nothing else. */
export interface BurnSplit {
  bars: BurnBar[]
  total: number
}

/** Bucket start as epoch ms. NaN for anything the store did not write. */
function hourKeyMs(hour: string): number {
  return Date.parse(hour)
}

/**
 * The start of the hour bucket `ms` falls in.
 *
 * IT MIRRORS THE STORE'S `toHourKey` DELIBERATELY (`store/sqlite/costs.ts`),
 * down to using `setMinutes(0, 0, 0)` rather than dividing by an hour: the store
 * writes bucket keys with that function and the route floors `?from=` with it
 * too, so a window boundary computed any other way would disagree with the rows
 * it is filtering in half-hour timezones.
 *
 * Every window on this pane is snapped through here, which is what makes `1h`
 * mean the last COMPLETE hour instead of an empty split: `hourly_stats` never
 * holds the hour in progress, so an unsnapped `now - 1h` would land mid-bucket
 * and exclude the only bucket there was.
 */
export function startOfHour(ms: number): number {
  const d = new Date(ms)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

/** Local midnight for `now` -- the boundary "today" actually means to a human
 *  reading the wall, not UTC's. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Cost in the buckets that START at or after `sinceMs`.
 *
 * Hourly buckets are UTC-aligned, so in a half-hour timezone the bucket
 * straddling local midnight is left out rather than split. Under-counting by at
 * most part of one hour beats apportioning a bucket we were never told the shape
 * of -- the latter would be an estimate wearing a measurement's clothes.
 */
export function costSince(rows: readonly BurnHourlyRow[], sinceMs: number): number {
  let total = 0
  for (const r of rows) {
    const at = hourKeyMs(r.hour)
    if (Number.isFinite(at) && at >= sinceMs) total += r.costUsd
  }
  return total
}

/** Fold labelled entries into a split, biggest first. Zero-cost entries are
 *  dropped: a bar of length zero is a row that says nothing and costs a line. */
function toSplit(entries: Array<{ key: string; label: string; costUsd: number }>): BurnSplit {
  const merged = new Map<string, BurnBar>()
  for (const e of entries) {
    if (!(e.costUsd > 0)) continue
    const prev = merged.get(e.key)
    if (prev) prev.costUsd += e.costUsd
    else merged.set(e.key, { key: e.key, label: e.label, costUsd: e.costUsd, share: 0 })
  }
  const bars = [...merged.values()].sort((a, b) => b.costUsd - a.costUsd || a.label.localeCompare(b.label))
  const total = bars.reduce((s, b) => s + b.costUsd, 0)
  for (const b of bars) b.share = total > 0 ? b.costUsd / total : 0
  return { bars, total }
}

/**
 * Per-PROJECT split from the hourly cost rows. `label` resolves a project URI to
 * whatever the rest of the panel calls that project -- passed in rather than
 * imported so this file stays free of the settings store.
 */
export function projectSplit(
  rows: readonly BurnHourlyRow[],
  sinceMs: number,
  label: (projectUri: string) => string,
): BurnSplit {
  return toSplit(
    rows
      .filter(r => {
        const at = hourKeyMs(r.hour)
        return Number.isFinite(at) && at >= sinceMs
      })
      // An empty project_uri is real: turns the store could not attribute. Saying
      // so is the point -- silently folding them into the biggest project would
      // make one project look more expensive than it was.
      .map(r => ({
        key: r.projectUri || '',
        label: r.projectUri ? label(r.projectUri) : 'unattributed',
        costUsd: r.costUsd,
      })),
  )
}

/**
 * Re-total a split after the wall's filter removed rows.
 *
 * The header total then always equals the sum of the bars under it, and a share
 * always means "of what you are looking at". Keeping the unfiltered total would
 * put a number in the header that no visible row contributes to, which is the
 * kind of small dishonesty that makes a whole pane untrustworthy.
 */
export function restrictSplit(bars: readonly BurnBar[]): BurnSplit {
  return toSplit(bars.map(b => ({ key: b.key, label: b.label, costUsd: b.costUsd })))
}

/** One row of the OpenRouter by-feature rollup, as `/api/stats/openrouter` sends it. */
export interface BurnFeatureRow {
  key: string
  costUsd: number
}

/** Per-FEATURE split. Its own total, deliberately -- see the file header. */
export function featureSplit(groups: readonly BurnFeatureRow[]): BurnSplit {
  return toSplit(groups.map(g => ({ key: g.key, label: g.key, costUsd: g.costUsd })))
}

/**
 * The cap state the month tile carries.
 *
 * `none` is the state the fleet is ACTUALLY in and the reason this exists: money
 * has been spent against no ceiling at all, and a tile that just showed a total
 * would let that keep being true quietly. Absent, zero and non-finite all mean
 * the same thing -- nobody set a cap -- and all say so out loud.
 */
export type BurnCapState = { kind: 'none' } | { kind: 'set'; capUsd: number; share: number; over: boolean }

export function capState(capUsd: number | undefined, spentUsd: number): BurnCapState {
  if (capUsd === undefined || !Number.isFinite(capUsd) || capUsd <= 0) return { kind: 'none' }
  return { kind: 'set', capUsd, share: spentUsd / capUsd, over: spentUsd > capUsd }
}

/** Dollars, at the precision the magnitude deserves. `--` for a number we were
 *  never given -- the dash is a value here, not a formatting failure. */
export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '--'
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

/** The headline rate. `--/h` when the window has not been observed long enough. */
export function formatRate(usdPerHour: number | null | undefined): string {
  return `${formatUsd(usdPerHour)}/h`
}
