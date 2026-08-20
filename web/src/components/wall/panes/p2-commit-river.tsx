/**
 * P2 COMMIT RIVER -- every commit the fleet lands, newest first.
 * Feed: `use-river-rows.ts` over the existing ledger (`commits.db`).
 *
 * THE ROW FORMAT IS SPECIFIED, NOT DESIGNED HERE:
 * `[delta-t] [hash] [{icon} project] {subject} {diff}`, with the project NAMED.
 * Attribution outranks subject length -- see `commit-river-row.tsx` for what
 * that costs and how the row reflows instead of paying it.
 *
 * FILTER: `text`, `@project`, `~time` and `&host`. Notably NOT `managed`: a
 * commit's `origin` says agent-or-human, which is not the same thing as
 * machine-DISPATCHED, and declaring the axis would let the grammar's
 * hide-machine-runs default empty this pane on an empty query box.
 *
 * The click seams are the ones that already exist: `openCommitDetail` for the
 * row (the same surface the commit browser opens, never a second commit view)
 * and the filter store's `toggleProject` for the project chip.
 */

import { useMemo } from 'react'
import { openCommitBrowser } from '@/hooks/use-commit-modals'
import { type RiverRow, riverBands } from '@/lib/wall/commit-river'
import { useWallFilter, type WallAxis, type WallRowFacets } from '@/lib/wall/filter'
import { handleChipCapture } from '../wall-chip-capture'
import { WallPane } from '../wall-pane'
import { CommitRiverRow } from './commit-river-row'
import { useRiverRows } from './use-river-rows'

const AXES: readonly WallAxis[] = ['text', 'project', 'time', 'host']

/** Free text searches the subject, the project, the sha and the branch. */
function facets(row: RiverRow): WallRowFacets {
  return {
    title: row.subject,
    project: row.projectName,
    action: `${row.shortHash} ${row.branch}`,
    ageMs: row.ageMs,
    host: row.host,
  }
}

export default function CommitRiverPane() {
  const { rows: all, loading, hasMore, stale } = useRiverRows()
  const { rows, matched, total } = useWallFilter(all, AXES, facets)
  const bands = useMemo(() => riverBands(rows), [rows])

  return (
    // `rewind="rows"`: a commit has a commit time, so rewinding is exactly "the
    // river as it read then" -- the commits that had not landed yet are dropped
    // by `useWallFilter`, never hidden by this pane.
    <WallPane title="COMMIT RIVER" code="P2" grow count={`${matched}/${total}`} stale={stale} rewind="rows">
      {rows.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">
          {loading ? 'reading the ledger' : total === 0 ? 'no commit in the ledger' : 'no commit matches the filter'}
        </p>
      ) : (
        <div className="wall-river" onClickCapture={handleChipCapture}>
          {bands.map(band => (
            <div key={band.bucket} className="wall-river-band">
              <div className="wall-river-sep">
                <span>{band.bucket}</span>
                <hr />
              </div>
              {band.rows.map(row => (
                <CommitRiverRow key={row.key} row={row} />
              ))}
            </div>
          ))}
          {/* A river that just stops reads as "that is every commit". It is one
              page of a ledger that goes back weeks, and the browser is where you
              go for the rest. */}
          {hasMore && (
            <button type="button" className="wall-river-more" onClick={() => openCommitBrowser()}>
              older commits are in the ledger -- open the commit browser
            </button>
          )}
        </div>
      )}
    </WallPane>
  )
}
