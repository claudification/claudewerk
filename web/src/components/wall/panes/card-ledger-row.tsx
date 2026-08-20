/**
 * One line of the ledger: `[age] [·project] {title} [priority] {from -> to}`.
 *
 * A DOT, NOT A NAME -- the one place on the wall where that is the right call,
 * and the card asks for it. P2 names its project in words because attribution IS
 * the question a commit river answers. Here the question is WHAT MOVED, the
 * title is the answer, and every row also has to carry two lane names and a
 * priority in the same 407px. The dot keeps its project's own colour and its
 * name in the tooltip and on `data-project`, so nothing is lost except the
 * twelve characters that were pushing the title out.
 *
 * THE DESTINATION IS EMPHASISED WHEN IT IS `done`. A ledger of lane crossings is
 * mostly bookkeeping; a card reaching `done` is the one line you scan for from
 * across the room, so it is the only one that gets the accent.
 *
 * A `div[role=button]` rather than a `<button>`: the project dot is a click
 * target of its own (scope the wall) and a button inside a button is invalid
 * HTML. The dot is intercepted in the CAPTURE phase by the pane's
 * `handleChipCapture`, which is also what stops it opening the card underneath.
 */

import type { ProjectTaskStatus } from '@shared/protocol'
import { haptic } from '@/lib/utils'
import type { LedgerRow } from '@/lib/wall/card-ledger'
import { PRIORITY_COLORS } from '../../project-board/board-constants'
import { ProjectIcon } from '../../project-icons'
import { navigateFromWall } from '../wall-navigate'
import { hoverCardRow, leaveWallRow } from '../wall-row-hover'

/** Lane names go out RAW. `inbox`, `in-progress`, `in-review` are what the card
 *  file says and what the editor's own `<option>`s say; a wall that renamed them
 *  to `In Progress` would be a second vocabulary for the same six lanes. */
function lane(status: ProjectTaskStatus): string {
  return status
}

export function CardLedgerRow({ row }: { row: LedgerRow }) {
  function open() {
    haptic('tick')
    navigateFromWall({ kind: 'card', project: row.project, id: row.id })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="wall-ledger-row"
      data-card={row.id}
      // `aria-label`, NOT `title`: this row opens a rich card preview on hover,
      // and a native tooltip renders ON TOP of it a second later -- two
      // descriptions of one card, the worse one winning. Same fix as the river
      // row; see `commit-river-row.tsx` for the screenshot that found it.
      aria-label={`${row.title} -- ${row.projectName} · ${lane(row.from)} -> ${lane(row.to)} · click -- the MAIN window opens this card`}
      onClick={open}
      onMouseEnter={event => hoverCardRow(row.id, row.project, event.currentTarget)}
      onMouseLeave={leaveWallRow}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        open()
      }}
    >
      <span className="wall-ledger-t">{row.age}</span>
      {/* `data-project` is the seam the pane's capture handler reads -- the dot
          click scopes the whole wall through the store's action, never here. */}
      <span
        className="wall-ledger-dot"
        data-project={row.projectName}
        style={row.projectColor ? { color: row.projectColor } : undefined}
        title={`Filter the whole wall to ${row.projectName}`}
      >
        {row.projectIcon ? <ProjectIcon iconId={row.projectIcon} className="size-[10px]" /> : <i />}
      </span>
      <span className="wall-ledger-title">{row.title}</span>
      {row.priority && <span className={`wall-ledger-prio ${PRIORITY_COLORS[row.priority]}`}>{row.priority}</span>}
      <span className="wall-ledger-move">
        <span className="wall-ledger-from">{lane(row.from)}</span>
        <span className="wall-ledger-arrow">-&gt;</span>
        <span className={row.isDone ? 'wall-ledger-to wall-ledger-done' : 'wall-ledger-to'}>{lane(row.to)}</span>
      </span>
    </div>
  )
}
