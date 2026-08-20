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
import { handleChipCapture } from '../wall-chip-capture'
import { navigateFromWall } from '../wall-navigate'
import { WallPane } from '../wall-pane'
import { wallPulseFleet } from '../wall-pulse-fleet'
import { useWallPulseStore } from '../wall-pulse-state'
import { hoverPulseRow, leaveWallRow } from '../wall-row-hover'
import { WallTab } from '../wall-tab'

/** Ask the feed for the WHOLE fleet -- see the file header. */
const WHOLE_FLEET = '+over'

/** Every axis. A pulse row is a conversation and carries all ten facets. */
const AXES = WALL_AXES

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

  /** The reveal affordance writes the token into the wall's box, so the user can
   *  see WHY the machine runs came back and delete it by hand. */
  function revealManaged() {
    const { raw, setRaw } = useWallFilterStore.getState()
    setRaw(raw.trim() ? `${raw.trim()} +over` : '+over')
  }

  /**
   * MARK IT AND OPEN IT. Selection is P1's own state (`wall-pulse-state` says so
   * in writing: selection is not navigation) and it stays -- the row you clicked
   * must still read as the row you clicked once the main window has come
   * forward. The open is the second verb, and it goes through the ONE transport,
   * so a detached wall focuses the conversation in the DASHBOARD rather than
   * behind the popup.
   */
  const onSelect = (row: PulseRow) => {
    select(row.id)
    navigateFromWall({ kind: 'conversation', id: row.id, via: 'wall-pulse' })
  }
  const onHover = (row: PulseRow, event: React.MouseEvent<HTMLElement>) => hoverPulseRow(row, event.currentTarget)
  const blocked = fleet.totals.blocked

  return (
    <WallPane
      title="PULSE"
      code="P1"
      grow
      // Every row carries `ageMs` (time since its last turn), so `useWallFilter`
      // has already dropped the conversations whose last turn is NEWER than the
      // cursor -- what is left is the fleet as it stood then.
      rewind="rows"
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
          <WallTab label="bands" active={view === 'bands'} onPick={() => setView('bands')} />
          <WallTab label="tide" active={view === 'tide'} onPick={() => setView('tide')} />
        </div>
      }
    >
      {/* Capture-phase only, over rows that are already <button>s -- the chip
          itself is never focusable and never steals the keyboard path. */}
      {/* The preview closes when the pointer leaves the PANE, not just a row:
          moving between two rows is a leave and an enter, and the layer's own
          pointerover rule already handles that without a flicker. */}
      <div onClickCapture={handleChipCapture} onMouseLeave={leaveWallRow}>
        {view === 'tide' ? (
          <PulseTideView fleet={fleet} activeId={selectedId} onSelect={onSelect} onHover={onHover} />
        ) : (
          <PulseBandsView
            fleet={fleet}
            activeId={selectedId}
            onSelect={onSelect}
            onHover={onHover}
            onRevealManaged={revealManaged}
          />
        )}
      </div>
    </WallPane>
  )
}
