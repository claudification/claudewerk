/**
 * One line of the river: `[delta-t] [hash] [{icon} project] {subject} {diff}`.
 *
 * THE PROJECT IS NAMED. Not a coloured dot -- a dot is a legend you have to
 * learn, and this pane exists to say WHOSE work landed, so it says it in words
 * with the project's own icon and colour. The consequence is that at the
 * mockup's column width (407px) the subject would truncate to about fourteen
 * characters, so the row REFLOWS instead: below 520px the subject drops to its
 * own line, in full, and the project tag never shrinks. See `wall.css`.
 *
 * A `div[role=button]` rather than a `<button>`: the copy affordance is a real
 * button and a button inside a button is invalid HTML. Enter and Space are wired
 * by hand for it, and the copy button stops the click from also opening the
 * detail.
 */

import { haptic } from '@/lib/utils'
import type { RiverRow } from '@/lib/wall/commit-river'
import { ProjectTag } from '../../project-tag'
import { WallCopyButton } from '../wall-copy-button'
import { navigateFromWall } from '../wall-navigate'
import { hoverCommitRow, leaveWallRow } from '../wall-row-hover'

/**
 * The row's accessible name -- NOT a `title`.
 *
 * It was a `title`, and the browser rendered its own tooltip on top of the rich
 * hover panel this row already opens: two overlapping descriptions of the same
 * commit, the worse one on top, roughly a second after the good one. Reported
 * 2026-08-20 with a screenshot of both at once.
 *
 * `aria-label` keeps every word of it for a screen reader, and for a keyboard
 * user whom the pointer-gated hover never serves. Nothing is lost; the native
 * tooltip is the only thing dropped, and the popover is strictly better than it.
 */
function rowLabel(row: RiverRow): string {
  const where = row.hasConversation
    ? `from ${row.conversationName ?? 'a conversation'}`
    : 'made at a terminal, outside any conversation'
  return `${row.subject} -- ${row.branch} · ${where} · click to open it here on the wall`
}

export function CommitRiverRow({ row }: { row: RiverRow }) {
  function open() {
    haptic('tick')
    // Through the ONE transport, with the IN-WALL target: a commit's detail is
    // a read, and the wall is on the second monitor precisely so the main window
    // can stay on whatever it was doing. Every other wall row still ships its
    // intent to the dashboard -- this is the exception Jonas asked for, and the
    // transport takes it as a parameter so it is one word rather than a second
    // mechanism.
    navigateFromWall({ kind: 'commit', hash: row.hash }, 'wall')
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="wall-river-row group"
      data-hash={row.shortHash}
      aria-label={rowLabel(row)}
      onClick={open}
      onMouseEnter={event => hoverCommitRow(row, event.currentTarget)}
      onMouseLeave={leaveWallRow}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        open()
      }}
    >
      <span className="wall-river-t">{row.age}</span>
      <span className="wall-river-sha">{row.shortHash}</span>
      {/* `data-project` is the seam the pane's capture handler reads -- the chip
          click scopes the whole wall through the store's action, never here. */}
      <ProjectTag
        className="wall-river-ptag"
        name={row.projectName}
        icon={row.projectIcon}
        color={row.projectColor}
        iconClassName="size-[11px]"
      />
      <span className="wall-river-msg">{row.subject}</span>
      <span className="wall-river-stat">
        <span className="wall-river-add">+{row.insertions}</span>{' '}
        <span className="wall-river-del">-{row.deletions}</span>
      </span>
      {/* THE FULL SHA, not the rendered line and not the seven characters on
          screen -- a copied hash you have to re-expand is a copy button that
          wasted your time. The wall's own button, not the generic one: this is
          the surface where a copy that silently failed is worst. */}
      <WallCopyButton text={row.hash} label={`the sha ${row.shortHash}`} className="wall-river-copy" />
    </div>
  )
}
