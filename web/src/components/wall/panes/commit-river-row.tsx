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
import { CopyIconButton } from '../../ui/copy-icon-button'
import { navigateFromWall } from '../wall-navigate'
import { hoverCommitRow, leaveWallRow } from '../wall-row-hover'

/** What the row promises the click will reach. The rich preview is the hover. */
function rowTitle(row: RiverRow): string {
  const where = row.hasConversation
    ? `from ${row.conversationName ?? 'a conversation'}`
    : 'made at a terminal, outside any conversation'
  return `${row.subject}\n${row.branch} · ${where} · click for the commit`
}

export function CommitRiverRow({ row }: { row: RiverRow }) {
  function open() {
    haptic('tick')
    // Through the ONE transport, so a detached wall reaches the main window
    // instead of opening a detail behind the popup you are looking at.
    // `wall-commit-detail-in-wall` flips this target to `wall`; that is the
    // only line it has to change.
    navigateFromWall({ kind: 'commit', hash: row.hash })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className="wall-river-row group"
      data-hash={row.shortHash}
      title={rowTitle(row)}
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
          wasted your time. */}
      <CopyIconButton text={row.hash} title={`Copy the sha ${row.shortHash}`} className="wall-river-copy" />
    </div>
  )
}
