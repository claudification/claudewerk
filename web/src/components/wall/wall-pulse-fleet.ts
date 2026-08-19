/**
 * The fold that turns a WALL-FILTERED row list back into a `PulseFleet`.
 *
 * P1 does not filter. It takes the WHOLE fleet from `usePulseFleet` and hands
 * every row to `useWallFilter`, because the wall has ONE query box and the pane
 * that owns the most axes must not also own a second predicate. What comes back
 * is a flat array, and the two pulse views want a fleet -- so this rebuilds one
 * around the survivors.
 *
 * Rebuilds, never re-filters: `rows` is already the answer. The only judgement
 * here is WHY a row went missing, and that is the one number the surface must
 * not get wrong. `hidden` is what the user TYPED; `managedHidden` is a default
 * they never chose. Conflating them reads as "your filter is too tight" when the
 * filter is empty -- the same distinction `use-pulse-fleet` draws, drawn here
 * because on the wall it is the wall query, not the feed, doing the hiding.
 */

import type { PulseBandGroup, PulseFleet, PulseRow } from '@/components/pulse/use-pulse-fleet'
import { VISIBLE_BANDS } from '@/components/pulse/use-pulse-fleet'
import type { PulseBand } from '@/lib/pulse/bands'
import { isEmptyQuery } from '@/lib/pulse/filter'
import type { WallQuery } from '@/lib/wall/query'

const NO_ROWS: Record<PulseBand, number> = { blocked: 0, needs: 0, working: 0, done: 0, idle: 0, expired: 0 }

/**
 * @param base   the unfiltered fleet, straight from the feed
 * @param rows   `base.flat` after `useWallFilter` -- band order preserved
 * @param expired `base.expired` after the same filter
 * @param query  the wall query, so rows can highlight their own hit
 */
export function wallPulseFleet(
  base: PulseFleet,
  rows: readonly PulseRow[],
  expired: readonly PulseRow[],
  query: WallQuery,
): PulseFleet {
  const shown = new Set(rows.map(r => r.id))
  let hidden = 0
  let managedHidden = 0
  for (const row of base.flat) {
    if (shown.has(row.id)) continue
    if (row.managed && !query.includeManaged) managedHidden += 1
    else hidden += 1
  }

  const totals = { ...NO_ROWS }
  for (const row of rows) totals[row.band] += 1
  totals.expired = expired.length

  // `rows` arrives in band order already (it is `base.flat` with rows removed),
  // so grouping is a partition, not a sort.
  const groups: PulseBandGroup[] = VISIBLE_BANDS.map(band => ({
    band,
    rows: rows.filter(r => r.band === band),
  })).filter(g => g.rows.length > 0)

  return {
    groups,
    flat: [...rows],
    totals,
    expired: [...expired],
    hidden,
    managedHidden,
    query,
    isEmpty: isEmptyQuery(query),
  }
}
