/**
 * THE VALUES A PANE RENDERS BUT DOES NOT HOLD.
 *
 * A pane's copy button emits a report of its CURRENT contents, and for most
 * panes that is trivial -- the pane derived the rows, so it can hand them to a
 * builder. Two do not:
 *
 *  - P4's four KPI tiles each own their own feed and their own subscription, on
 *    purpose: the token ring notifies at ~1 Hz and the 24h total refetches every
 *    five minutes, and neither is allowed to drag the other three tiles through
 *    a re-render. The 24h number therefore lives in one tile's `useState` and
 *    nowhere else.
 *  - A2's headline rate is folded from wall frames into a ref inside `BurnLive`,
 *    which is fenced off from the rest of the pane for exactly the same reason.
 *
 * The alternatives were both worse than this bus. Lifting the state to the pane
 * re-renders the whole pane at the fastest feed's cadence, which is the thing
 * those two files were split to prevent. Re-deriving the values in the report
 * builder is a SECOND implementation of each number -- and a report that says
 * something different from the tile above it is worse than no report.
 *
 * So a tile PUBLISHES what it is showing, and the report READS it. Two rules
 * keep that honest:
 *
 *  1. A reading is published as the STRING the tile rendered, so the paste and
 *     the screen cannot round differently.
 *  2. Unmounting CLEARS the slot. A tile the filter removed must vanish from the
 *     report too, and a stale reading for a tile nobody is showing is exactly
 *     the phantom the wall's staleness contract exists to refuse.
 *
 * Module scope is right here: a detached wall is a separate window with its own
 * module instance, so its readings are its own.
 */

import { useEffect } from 'react'

/** What a published reading is: the label the tile prints and its value. */
export interface WallReading {
  label: string
  /** Exactly what is on screen. `null` = the tile is showing a dash. */
  value: string | null
  /** The tile's small caption, when it has one worth pasting. */
  sub?: string
  /** The value is real but was read on an EARLIER connection. */
  stale?: boolean
}

/** Insertion-ordered: a Map preserves it, so a report reads in tile order. */
const readings = new Map<string, WallReading>()

/**
 * Publish this component's current reading for as long as it is mounted.
 *
 * The write is in an effect rather than in render because render can run twice
 * under StrictMode and can be thrown away entirely by a suspended tree -- a
 * publish from a render that never committed would leave the report describing a
 * tile that is not on screen.
 */
export function usePublishReading(key: string, reading: WallReading): void {
  const { label, value, sub, stale } = reading
  useEffect(() => {
    readings.set(key, { label, value, ...(sub === undefined ? {} : { sub }), ...(stale ? { stale: true } : {}) })
    return () => {
      readings.delete(key)
    }
  }, [key, label, value, sub, stale])
}

/**
 * Every reading currently on screen whose key starts with `prefix`, in mount
 * order.
 *
 * The prefix is not optional and the keys are namespaced per pane (`p4-`,
 * `a2-`) for one reason: this is ONE module-scope map shared by every publisher
 * on the surface, and a pane that folded the whole map would put another pane's
 * numbers in its own report the day a third publisher appeared.
 */
export function wallReadings(prefix: string): WallReading[] {
  const out: WallReading[] = []
  for (const [key, reading] of readings) {
    if (key.startsWith(prefix)) out.push(reading)
  }
  return out
}

/** One reading by key, or null when nothing is publishing it. */
export function wallReading(key: string): WallReading | null {
  return readings.get(key) ?? null
}

/** Test seam: no component is mounted between tests, but the module is. */
export function clearWallReadings(): void {
  readings.clear()
}
