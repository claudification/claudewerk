/**
 * P3 CARD LEDGER -- board cards changing lane, newest first, epics excluded.
 * Feed: the card-change events (`card-ledger-feed.ts`), riding the wall frame.
 *
 * WHAT THIS ANSWERS that the board does not: the board shows where every card IS
 * and says nothing about how it got there. This is the other half -- one line per
 * crossing, in order, so "what has the fleet actually closed in the last hour" is
 * a glance instead of a diff of two board screenshots.
 *
 * EPICS NEVER APPEAR, and there is no filter here that makes that true. The
 * sentinel drops epic cards where the move is observed, so the exclusion holds
 * for every consumer at once and no UI can forget to apply it. If an epic ever
 * shows up on this pane the bug is upstream in `card-moves.ts`, not here.
 *
 * ALL/DONE IS A VIEW, NOT A FILTER. It picks which rows this pane is ABOUT, and
 * it runs BEFORE `useWallFilter` -- so `{matched}/{total}` keeps meaning "of what
 * this view holds, how much the query box left" with either tab up.
 *
 * FILTER: `text`, `@project` and `~time`, and nothing else. A card move has no
 * cost, no context pressure, no model and no host, and `managed` is deliberately
 * absent too -- a card moved BY an unattended run and a card moved by hand are
 * the same event to a ledger, and declaring the axis would let the grammar's
 * hide-machine-runs default empty this pane on an empty query box.
 */

import { useMemo } from 'react'
import type { LedgerRow } from '@/lib/wall/card-ledger'
import { useWallFilter, type WallAxis, type WallRowFacets } from '@/lib/wall/filter'
import { cardLedgerReport } from '@/lib/wall/pane-reports'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { handleChipCapture } from '../wall-chip-capture'
import { WallPane } from '../wall-pane'
import { WallTab } from '../wall-tab'
import { BrokenPromiseTable } from './broken-promise-table'
import { CardLedgerRow } from './card-ledger-row'
import { useCardLedgerViewStore } from './card-ledger-view'
import { useCardVerdicts } from './use-card-verdicts'
import { useLedgerRows } from './use-ledger-rows'

const AXES: readonly WallAxis[] = ['text', 'project', 'time']

/** Free text searches the title, the project and the card's own id and lanes --
 *  you look for a move by the card slug you remember as often as by its title. */
function facets(row: LedgerRow): WallRowFacets {
  return {
    title: row.title,
    project: row.projectName,
    action: `${row.id} ${row.from} ${row.to}`,
    ageMs: row.ageMs,
  }
}

export default function CardLedgerPane() {
  const all = useLedgerRows()
  const view = useCardLedgerViewStore(s => s.view)
  const setView = useCardLedgerViewStore(s => s.setView)

  const inView = useMemo(() => (view === 'done' ? all.filter(row => row.isDone) : all), [all, view])
  const { rows, matched, total } = useWallFilter(inView, AXES, facets)
  const reportView = useWallReportView()
  // Asked for the FEED's projects, not the filtered rows'. A query box that
  // leaves no moves on screen must not also empty the loud table -- a card filed
  // as finished with nothing behind it does not stop being one because somebody
  // typed `~10m`. The ask is still bounded: only projects the move ring has seen.
  const verdicts = useCardVerdicts(all)

  return (
    <WallPane
      title="CARD LEDGER"
      code="P3"
      maxHeight="32%"
      report={() => cardLedgerReport(rows, reportView)}
      // A card move IS a timestamped event, so the cursor reads exactly: the
      // board as it stood. `useWallFilter` drops the moves that came later.
      rewind="rows"
      count={`${matched}/${total}`}
      tabs={
        <div className="flex gap-[2px]">
          <WallTab label="all" active={view === 'all'} onPick={() => setView('all')} title="Every lane crossing" />
          <WallTab
            label="done"
            active={view === 'done'}
            onPick={() => setView('done')}
            title="Only the cards that reached done"
          />
        </div>
      }
    >
      {/* ABOVE the empty-state branch and OUTSIDE it. A filter that leaves no
          moves on screen does not make a card filed as finished with nothing
          behind it stop being one, and this table going quiet whenever the
          ledger did would let a query box hide the only thing on the pane that
          is an accusation. */}
      <BrokenPromiseTable rows={verdicts.broken} refused={verdicts.refused} />
      {rows.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">
          {total === 0
            ? view === 'done'
              ? 'nothing has reached done yet'
              : 'no card has moved yet'
            : 'no move matches the filter'}
        </p>
      ) : (
        <div className="wall-ledger" onClickCapture={handleChipCapture}>
          {rows.map(row => (
            <CardLedgerRow key={row.key} row={row} verdict={verdicts.verdictFor(row.project, row.id)} />
          ))}
        </div>
      )}
    </WallPane>
  )
}
