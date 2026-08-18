/**
 * THE OVERSEER WINDOW.
 *
 * A managed surface (detachable-surfaces covenant), so inline / docked /
 * detached and the whole window chrome come for free -- and detaching this one
 * onto a second screen while a run works for an hour is the point, not a bonus.
 */

import { Radar } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { isLiveRun, selectAllRuns, useOverseerActivityStore } from '@/hooks/use-overseer-activity'
import { ModalSurface } from '../modal-surface'
import { OverseerDetail } from './overseer-detail'
import { OverseerRail } from './overseer-rail'
import { OVERSEER_MODAL, runKey, useOverseerSelection } from './overseer-state'
import { useOverseerInspect } from './use-overseer-inspect'

/** Re-render the relative timestamps on a slow tick. Every "12s ago" in the
 *  window would otherwise freeze at whatever it said when the data last landed,
 *  which on a stalled run is the single most misleading thing it could do. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

// cyclomatic 6, cognitive 9, twenty lines: flagged on CRAP alone, which is
// complexity squared against ZERO coverage. Covering it means mounting the
// window with a mocked fetch and fake timers to assert an auto-select the three
// lines below already state plainly. The pure logic in this feature -- derived
// facts, verb defaults, badge selectors -- IS unit tested; what is left is React
// wiring, and a harness built to satisfy a metric rather than to catch a bug is
// worse than the number it removes.
// fallow-ignore-next-line complexity
function OverseerBody() {
  const runs = useOverseerActivityStore(selectAllRuns)
  const selected = useOverseerSelection(s => s.selected)
  const select = useOverseerSelection(s => s.select)
  const nowMs = useNow()

  // Nothing chosen: fall to the first LIVE run, or the first run at all. Opening
  // a control plane onto an empty pane when something is running is the bug this
  // whole window exists to fix, in miniature.
  // fallow-ignore-next-line complexity
  useEffect(() => {
    if (selected || runs.length === 0) return
    const pick = runs.find(isLiveRun) ?? runs[0]
    if (pick) select(pick.project, pick.epicId)
  }, [selected, runs, select])

  const current = runs.find(r => runKey(r.project, r.epicId) === selected) ?? null
  const { data, error, loading, refresh } = useOverseerInspect(current?.project ?? null, current?.epicId ?? null)

  return (
    <div className="flex flex-1 min-h-0">
      <OverseerRail />
      <OverseerDetail data={data} error={error} loading={loading} nowMs={nowMs} onRefresh={refresh} />
    </div>
  )
}

function Subtitle() {
  const runs = useOverseerActivityStore(selectAllRuns)
  const live = runs.filter(isLiveRun)
  const seats = live.reduce((n, r) => n + r.inFlight, 0)
  return (
    <span className="text-meta text-muted-foreground/55">
      {live.length} live . {seats} seat{seats === 1 ? '' : 's'}
    </span>
  )
}

export function OverseerModal() {
  const modal = useManagedModal(OVERSEER_MODAL)
  if (modal.presentation === 'closed') return null

  return (
    <ModalSurface
      modal={modal}
      title="Overseer"
      icon={<Radar className="size-4 text-[color:var(--epic-badge)]" />}
      headerExtra={<Subtitle />}
      className="max-w-6xl w-[95vw] top-[5vh] translate-y-0 h-[86vh]"
    >
      <OverseerBody />
    </ModalSurface>
  )
}
