/**
 * A8 PINNED EPICS -- the watchlist.
 *
 * You pin an epic from the board; it lives here with a progress bar and the list
 * of cards that are NOT closed. It answers "how far along, and what is left"
 * without opening the board.
 *
 * NOT A7. `a7-unattended-runs` shows MACHINE state -- DAG buckets, werk-master
 * lease, baton -- for epics that are RUNNING. This is YOUR WATCHLIST, running or
 * not: a pinned epic with nothing running shows a bar and no beats, and that is
 * the correct render. Two questions, two panes, and no beat rendering here.
 *
 * Feed: the project board itself (`wall_pinned: true` in an epic card's
 * frontmatter). See `use-wall-pins.ts`.
 */

import { pinnedReport } from '@/lib/wall/pane-reports'
import { useWallFilter } from '@/lib/wall/use-wall-filter'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { PinnedEpicRow } from '../pinned-epic-row'
import { useWallPins } from '../use-wall-pins'
import { WallPane } from '../wall-pane'

/**
 * PROJECT, its WORKSPACE, and TEXT, and nothing else. An axis this pane does not
 * declare is
 * stripped from the query before a row is looked at, so `%80` or `:opus` leaves
 * the watchlist FULL rather than blank -- an epic has no context pressure and no
 * model, and a pane that went empty for one would be lying.
 */
const AXES = ['project', 'workspace', 'text'] as const

/** A REFUSAL IS NOT AN EMPTY WATCHLIST. The commonest cause is a sentinel bundle
 *  that predates the `pinned` op entirely -- it answers `ok: false`, and this pane
 *  used to render that as "nothing pinned", which is how a pin that never landed
 *  looked exactly like a pin nobody made. */
function PinRefusal({ error }: { error: string }) {
  return (
    <p className="text-meta text-warning px-0.5 py-1">
      cannot read pins -- {error}. If your sentinel predates A8 it does not know the `pinned` op:{' '}
      <code>bun run build:packages</code> and restart it.
    </p>
  )
}

export default function PinnedEpicsPane() {
  const { rows: pins, stale, refused } = useWallPins()
  const { rows, matched, total } = useWallFilter(pins, AXES, row => ({
    project: row.projectName,
    title: row.epicTitle,
    // The card names are part of the haystack: you look for an epic by the card
    // you remember, not always by the epic's own title.
    action: row.children.map(c => c.title).join(' '),
  }))
  const view = useWallReportView()

  return (
    <WallPane
      title="PINNED"
      code="A8"
      maxHeight="34%"
      count={`${matched}/${total} pinned`}
      stale={stale}
      report={() => pinnedReport(rows, view)}
    >
      {refused && rows.length === 0 ? (
        <PinRefusal error={refused} />
      ) : rows.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">
          {total === 0 ? 'nothing pinned -- pin an epic from the board to watch it here' : 'no pinned epic matches'}
        </p>
      ) : (
        rows.map(row => <PinnedEpicRow key={`${row.project}/${row.epicId}`} row={row} />)
      )}
    </WallPane>
  )
}
