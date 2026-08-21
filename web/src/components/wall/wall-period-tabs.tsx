/**
 * THE PERIOD CONTROL -- one component, one store, rendered on the panes that
 * actually obey it.
 *
 * WHY IT IS NOT IN THE WALL HEADER beside the filter box and the scrubber. Those
 * two are wall-WIDE by construction: every pane runs its rows through
 * `useWallFilter`, and the cursor narrows or blinds every pane whether or not it
 * knows the cursor exists. A period does not work that way -- only a pane with a
 * real windowed feed can honour one, and today that is A2 alone (P4 fleet and A6
 * sheaf have no window concept, S1 host vitals must not grow one). A control in
 * the header promises the whole wall re-scoped; sitting in the head of the pane
 * it re-scopes, it promises exactly what it delivers.
 *
 * THE STATE IS STILL WALL-WIDE. The control is stateless: it renders and writes
 * `wall-period-store`, which is module scope. The second pane to render this
 * control shows the same window as the first by construction, and neither can
 * drift -- "one period control, one source of truth" is a fact about the store,
 * not about how many places the buttons appear.
 */

import { useWallPeriodStore, WALL_PERIODS, type WallPeriod } from '@/lib/wall/period-store'
import { WallTab } from './wall-tab'

/** Hover text per option, for the two whose short label hides a bound. */
const NOTES: Partial<Record<WallPeriod, string>> = {
  '1h': 'the last COMPLETE hour -- hourly cost buckets exclude the hour in progress',
  '1m': '30 days -- the stats retention bound, not a calendar month',
}

export function WallPeriodTabs() {
  const period = useWallPeriodStore(s => s.period)
  const setPeriod = useWallPeriodStore(s => s.setPeriod)
  return (
    <div className="flex gap-[2px]" role="group" aria-label="stats period">
      {WALL_PERIODS.map(p => (
        <WallTab key={p} label={p} active={p === period} onPick={() => setPeriod(p)} title={NOTES[p]} />
      ))}
    </div>
  )
}
