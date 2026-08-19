/**
 * P1 PULSE -- the fleet grouped by activity band, with a TIDE alternative.
 * Feed: web/src/components/pulse/use-pulse-fleet.ts.
 *
 * A MOUNT, NOT A REWRITE. The bands view, the tide view, the row and the band
 * palette (`PULSE_BAND_STYLE`) are the ones the palette and the strip already
 * use. Pulse's vocabulary -- glyph, colour, band order, fold, the expired bar --
 * has to mean the same thing on the wall as it does in the palette, and the only
 * way to guarantee that is to render the same components.
 *
 * WHAT THIS FILE OWNS: the BANDS/TIDE toggle, the count, the selection, and the
 * wiring into the wall's shared filter.
 *
 * THE FEED IS ASKED FOR EVERYTHING (`+over`) AND FILTERS NOTHING. P1 is the one
 * pane that understands the whole grammar, so every axis -- including the
 * hide-machine-runs default -- is applied ONCE, by `useWallFilter`, from the
 * wall's own query box. Letting the feed pre-filter would fork the predicate and
 * make `+over` typed on the wall a no-op here.
 */

import { useMemo } from 'react'
import { PulseBandsView } from '@/components/pulse/pulse-bands-view'
import { PulseTideView } from '@/components/pulse/pulse-tide-view'
import { type PulseRow, usePulseFleet } from '@/components/pulse/use-pulse-fleet'
import { PULSE_BAND_STYLE } from '@/lib/pulse/band-style'
import { cn } from '@/lib/utils'
import { WALL_AXES } from '@/lib/wall/axes'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { useWallFilter } from '@/lib/wall/use-wall-filter'
import { WallPane } from '../wall-pane'
import { wallPulseFleet } from '../wall-pulse-fleet'
import { useWallPulseStore, type WallPulseView } from '../wall-pulse-state'

/** Ask the feed for the WHOLE fleet -- see the file header. */
const WHOLE_FLEET = '+over'

/** Every axis. A pulse row is a conversation and carries all ten facets. */
const AXES = WALL_AXES

function ViewTab({ view, current, onPick }: { view: WallPulseView; current: WallPulseView; onPick: () => void }) {
  const on = view === current
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className={cn(
        'text-[10px] px-[7px] py-[2px] rounded-[3px] border transition-colors',
        on
          ? 'bg-background text-foreground border-primary/25'
          : 'border-transparent text-comment hover:text-foreground',
      )}
    >
      {view.toUpperCase()}
    </button>
  )
}

export default function PulsePane() {
  const base = usePulseFleet(WHOLE_FLEET)
  const query = useWallFilterStore(s => s.query)
  const { rows, matched, total } = useWallFilter(base.flat, AXES)
  const expired = useWallFilter(base.expired, AXES)
  // The feed ticks once a second so ages stay honest; the regroup is O(rows) and
  // must not also run for every unrelated store write on the surface.
  const fleet = useMemo(() => wallPulseFleet(base, rows, expired.rows, query), [base, rows, expired.rows, query])

  const view = useWallPulseStore(s => s.view)
  const setView = useWallPulseStore(s => s.setView)
  const selectedId = useWallPulseStore(s => s.selectedId)
  const select = useWallPulseStore(s => s.select)

  /**
   * THE PROJECT CHIP. A row is a `<button>`, so the chip inside it cannot be
   * one -- the click is intercepted on the way DOWN instead, which is also what
   * stops the row selecting itself when you only meant to scope the wall.
   *
   * It calls the store's exported action. There is exactly one implementation of
   * "scope to this project, or clear it if it is already the scope" in the tree
   * and it is not in this file.
   */
  function handleChipCapture(event: React.MouseEvent<HTMLDivElement>) {
    const chip = (event.target as HTMLElement).closest('[data-project]')
    const project = chip?.getAttribute('data-project')
    if (!project) return
    event.stopPropagation()
    useWallFilterStore.getState().toggleProject(project)
  }

  /** The reveal affordance writes the token into the wall's box, so the user can
   *  see WHY the machine runs came back and delete it by hand. */
  function revealManaged() {
    const { raw, setRaw } = useWallFilterStore.getState()
    setRaw(raw.trim() ? `${raw.trim()} +over` : '+over')
  }

  const onSelect = (row: PulseRow) => select(row.id)
  const blocked = fleet.totals.blocked

  return (
    <WallPane
      title="PULSE"
      code="P1"
      grow
      count={
        // Rose the moment anything is BLOCKED ON YOU: across a room the count is
        // the only part of this pane you can still read. Same table as the rows,
        // no new palette.
        <span className={cn('tabular-nums', blocked > 0 && PULSE_BAND_STYLE.blocked.text)}>
          {matched}/{total}
          {fleet.managedHidden > 0 && ` (${fleet.managedHidden} over)`}
        </span>
      }
      tabs={
        <div className="flex gap-[2px]">
          <ViewTab view="bands" current={view} onPick={() => setView('bands')} />
          <ViewTab view="tide" current={view} onPick={() => setView('tide')} />
        </div>
      }
    >
      {/* Capture-phase only, over rows that are already <button>s -- the chip
          itself is never focusable and never steals the keyboard path. */}
      <div onClickCapture={handleChipCapture}>
        {view === 'tide' ? (
          <PulseTideView fleet={fleet} activeId={selectedId} onSelect={onSelect} />
        ) : (
          <PulseBandsView fleet={fleet} activeId={selectedId} onSelect={onSelect} onRevealManaged={revealManaged} />
        )}
      </div>
    </WallPane>
  )
}
