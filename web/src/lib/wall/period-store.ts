/**
 * THE WALL's stats PERIOD -- one window, held OUTSIDE the surface's component
 * tree, and the only thing on the wall that answers "over how long?".
 *
 * MODULE SCOPE, same construction as `filter-store.ts` and `cursor-store.ts` and
 * for the same reason: THE WALL moves between `inline`, `docked`, `detached` and
 * ambient, and every one of those transitions unmounts and remounts the tree. A
 * period held in a provider would snap back to 24h every time the wall was
 * popped out -- silently, and looking exactly like a wall that was never
 * re-scoped.
 *
 * IT ALSO SURVIVES RELOAD, which the filter and the cursor deliberately do not.
 * A query and a rewind are things you are DOING right now; a period is how you
 * read this wall, and re-picking `7d` after every refresh is the kind of small
 * tax that ends with everyone leaving it on the default. Persisted per-device to
 * `localStorage`, the same way `live-dialog-prefs` and `use-board-view-config`
 * keep per-viewer panel prefs -- no broker round trip, because this is a fact
 * about a screen and not about the fleet.
 *
 * THE PERIOD IS NOT THE CURSOR. `use-wall-cursor` is a scrub POSITION (how far
 * back the wall is showing); this is a WINDOW LENGTH (how much of the past a
 * stats fold covers). They compose and neither replaces the other. S1 host
 * vitals has the first and deliberately no second -- see its own header comment
 * (`panes/s1-host-vitals.tsx`): a live node's sample is seconds old, so a window
 * would drop nothing for a healthy node while HIDING that a stale node went
 * quiet, which is the one thing that pane exists to show.
 *
 * THE SEAM. `wall-vitals-history-store` builds the actual cpu/ram/disk/token
 * history table. When it lands it reads THIS field for its window rather than
 * inventing a second period concept -- one control, one source of truth.
 *
 * Per `feedback_zustand_no_object_selectors`, select ONE field at a time.
 */

import { create } from 'zustand'

/**
 * The six windows the wall offers, in the order they are shown.
 *
 * `1m` MEANS 30 DAYS, NOT A CALENDAR MONTH, and that is a hard bound rather than
 * a rounding: both stats stores prune at thirty days (`COST_RETENTION_MS` for
 * the Anthropic side, `RETENTION_MS` for OpenRouter), so a calendar-month window
 * would be missing its first days for most of the month while looking complete.
 * Nothing longer than `1m` may be added here without the stores growing a longer
 * retention first -- a 90d option over a 30d table is a wrong number wearing a
 * confident label.
 */
export type WallPeriod = '1h' | '6h' | '24h' | '3d' | '7d' | '1m'

export const WALL_PERIODS: readonly WallPeriod[] = ['1h', '6h', '24h', '3d', '7d', '1m']

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** How far back each period reaches. `1m` is the retention bound -- see above. */
export const WALL_PERIOD_MS: Record<WallPeriod, number> = {
  '1h': HOUR_MS,
  '6h': 6 * HOUR_MS,
  '24h': DAY_MS,
  '3d': 3 * DAY_MS,
  '7d': 7 * DAY_MS,
  '1m': 30 * DAY_MS,
}

/** What the wall opens on. 24h is what A2 hardcoded before this control existed,
 *  so an untouched wall reads exactly as it always did. */
export const DEFAULT_WALL_PERIOD: WallPeriod = '24h'

const KEY = 'claudewerk.wallPeriod.v1'

/** localStorage is absent in node/bun test runs (and can throw in private mode). */
function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** A stored value is only trusted if it is still one of the offered periods: the
 *  option list is allowed to change, and a dropped option must fall back to the
 *  default rather than reach a feed as an unknown window. */
export function loadWallPeriod(): WallPeriod {
  const raw = storage()?.getItem(KEY)
  return WALL_PERIODS.includes(raw as WallPeriod) ? (raw as WallPeriod) : DEFAULT_WALL_PERIOD
}

function saveWallPeriod(period: WallPeriod): void {
  try {
    storage()?.setItem(KEY, period)
  } catch {
    // quota / private mode -- the store still holds it for this session.
  }
}

interface WallPeriodState {
  /** The window every windowed stats fold on the wall covers. */
  period: WallPeriod
  /** Pick a window. Persisted per-device; a no-op write re-renders nothing. */
  setPeriod(period: WallPeriod): void
}

export const useWallPeriodStore = create<WallPeriodState>((set, get) => ({
  period: loadWallPeriod(),

  setPeriod: period => {
    if (get().period === period) return
    saveWallPeriod(period)
    set({ period })
  },
}))

/**
 * Test-only: forget both halves of the persisted period.
 *
 * The store reads storage ONCE at module init, so a test that only cleared
 * `localStorage` would keep whatever the first test wrote for the rest of the
 * file.
 */
export function resetWallPeriod(): void {
  try {
    storage()?.removeItem(KEY)
  } catch {
    // nothing to forget.
  }
  useWallPeriodStore.setState({ period: DEFAULT_WALL_PERIOD })
}
