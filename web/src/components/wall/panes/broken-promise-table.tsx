/**
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  FILED AS FINISHED WITH NO COMMIT BEHIND IT.                             ┃
 * ┃                                                                          ┃
 * ┃  This table is the feature. Everything else on this pane is bookkeeping. ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * Moving a card to `done` is free, and the WERK engine does it on its own
 * authority at machine speed with the done-gate off. 70-odd cards went to `done`
 * during THE WALL and nothing in this repo could say which commit delivered any
 * of them. This is what makes that expensive.
 *
 * IT IS STICKY, AND THAT IS THE REQUIREMENT, NOT A FLOURISH. The card asks for a
 * table "a person cannot scroll past"; the pane body is the only thing that
 * scrolls, so the table pins to the top of it and the ledger scrolls underneath.
 * A subtle grey pill in a corner would have been the same information and none
 * of the point.
 *
 * EVERY ROW SAYS WHY IT IS HERE. The heading is exactly true of `not started`
 * and only roughly true of a card that named a sha nobody could resolve -- so
 * the row carries its own reason (`brokenReason`) rather than letting the
 * heading over-claim on its behalf. A table that over-claims is one people learn
 * to discount, and a discounted table is the state we started in.
 */

import type { PromiseRow } from '@shared/promise-ledger'
import { brokenReason } from '@/lib/promise-verdict'
import { haptic } from '@/lib/utils'
import { navigateFromWall } from '../wall-navigate'
import { PromiseVerdictChip } from './promise-verdict-chip'

export type BrokenRow = PromiseRow & { project: string }

/** How many rows show before the table starts counting. Enough to read as a
 *  wall of shame at a glance, few enough that it cannot push the ledger it sits
 *  on top of off the pane entirely. The remainder is COUNTED, never dropped in
 *  silence -- a silent cap reads as "that is everything". */
const CAP = 6

export function BrokenPromiseTable({ rows, refused }: { rows: readonly BrokenRow[]; refused: string | null }) {
  // Nothing to shout about and nothing that failed to answer: render nothing at
  // all. A permanently-present "0 broken promises" banner is how a loud table
  // becomes furniture, and furniture is invisible.
  if (rows.length === 0 && refused === null) return null

  const shown = rows.slice(0, CAP)
  const hidden = rows.length - shown.length

  return (
    <div className="wall-broken" role="group" aria-label="filed as finished with NO commit behind it">
      <div className="wall-broken-head">
        <span className="wall-broken-title">FILED AS FINISHED WITH NO COMMIT BEHIND IT</span>
        <span className="wall-broken-count">{rows.length}</span>
      </div>
      {shown.map(row => (
        <BrokenPromiseRow key={`${row.project}::${row.id}`} row={row} />
      ))}
      {hidden > 0 && <p className="wall-broken-more">+ {hidden} more filed with nothing behind them</p>}
      {refused !== null && (
        // A refusal is NOT an empty table. Saying so beside the rows is what
        // keeps "we cannot tell" from rendering as "nothing is wrong".
        <p className="wall-broken-refused">could not check every project -- {refused}</p>
      )}
    </div>
  )
}

function BrokenPromiseRow({ row }: { row: BrokenRow }) {
  function open() {
    haptic('tick')
    navigateFromWall({ kind: 'card', project: row.project, id: row.id })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="wall-broken-row"
      data-card={row.id}
      aria-label={`${row.title} -- ${row.status}, ${brokenReason(row.verdict)} · click -- the MAIN window opens this card`}
      onClick={open}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        open()
      }}
    >
      <PromiseVerdictChip verdict={row.verdict} showWord={false} />
      <span className="wall-broken-card">{row.id}</span>
      <span className="wall-broken-why">{brokenReason(row.verdict)}</span>
      <span className="wall-broken-lane">{row.status}</span>
    </div>
  )
}
