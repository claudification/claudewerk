import { useRef } from 'react'
import type { PulseBandGroup, PulseFleet, PulseRow } from './use-pulse-fleet'

/**
 * FREEZE THE LAYOUT WHILE THE USER IS READING IT.
 *
 * Pulse sorts by recency, which is right for a glance and hostile to a click:
 * WORKING churns every second or two, so a row you are reaching for slides out
 * from under the pointer before mouse-up lands. Jonas: "otherwise I can't flick
 * things."
 *
 * While frozen, POSITIONS are held and CONTENT stays live — ages still tick,
 * action text still updates, counts still move. Only the running order stops.
 *
 * Why frozen rather than throttled to a few seconds: a throttle does not fix
 * this, it makes it rarer. The row can still jump at the exact moment you commit
 * to clicking it, and a bug that fires one time in twenty is worse than one that
 * fires every time, because you stop expecting it. The fleet is small enough
 * that a stale order costs nothing for the seconds a bloom is open.
 */

/** Band -> row ids, in the order they were on screen when the freeze began. */
type Layout = Array<{ band: PulseBandGroup['band']; ids: string[] }>

function snapshot(groups: PulseBandGroup[]): Layout {
  return groups.map(g => ({ band: g.band, ids: g.rows.map(r => r.id) }))
}

function indexRows(groups: PulseBandGroup[]): Map<string, PulseRow> {
  const live = new Map<string, PulseRow>()
  for (const group of groups) {
    for (const row of group.rows) live.set(row.id, row)
  }
  return live
}

/** Held positions, minus anything that has since disappeared. */
function heldGroups(remembered: Layout, live: Map<string, PulseRow>): PulseBandGroup[] {
  const groups: PulseBandGroup[] = []
  for (const { band, ids } of remembered) {
    const rows = ids.map(id => live.get(id)).filter((r): r is PulseRow => r !== undefined)
    if (rows.length) groups.push({ band, rows })
  }
  return groups
}

/** Arrivals go on the END of their band, so no held row shifts down. */
function appendArrivals(groups: PulseBandGroup[], fleet: PulseFleet): PulseBandGroup[] {
  const placed = new Set(groups.flatMap(g => g.rows.map(r => r.id)))
  const out = groups.map(g => ({ ...g }))
  for (const group of fleet.groups) {
    const arrivals = group.rows.filter(r => !placed.has(r.id))
    if (!arrivals.length) continue
    const existing = out.find(g => g.band === group.band)
    if (existing) existing.rows = [...existing.rows, ...arrivals]
    else out.push({ band: group.band, rows: arrivals })
  }
  return out
}

/**
 * @param resetKey  changing this retakes the snapshot even while frozen. The
 *   palette is open for its whole life, so without this a typed filter would be
 *   projected through an order captured before those rows existed.
 */
export function useFrozenLayout(fleet: PulseFleet, frozen: boolean, resetKey = ''): PulseFleet {
  const layoutRef = useRef<Layout | null>(null)
  const keyRef = useRef(resetKey)

  const stale = keyRef.current !== resetKey
  if (stale) keyRef.current = resetKey

  if (!frozen || stale) {
    // Re-snapshot while closed (so the NEXT freeze starts from what is actually
    // on screen) and whenever the reset key moves.
    layoutRef.current = snapshot(fleet.groups)
    return fleet
  }

  // Mounted already frozen -- the palette's normal case, since it is created
  // open. Without this it would never capture a first layout and would not
  // freeze at all.
  if (!layoutRef.current) {
    layoutRef.current = snapshot(fleet.groups)
    return fleet
  }
  const remembered = layoutRef.current

  const groups = appendArrivals(heldGroups(remembered, indexRows(fleet.groups)), fleet)
  return { ...fleet, groups, flat: groups.flatMap(g => g.rows) }
}
