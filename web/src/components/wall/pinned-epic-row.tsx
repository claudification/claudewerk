/**
 * ONE pinned epic: the progress line, and what is LEFT under it.
 *
 * THE NUMBERS SIT NEXT TO THE BAR, always. `1/2` and `50/100` draw an identical
 * bar and only one of them means anything, so a bar without its counts is a lie
 * about scale.
 *
 * HOVER stays here; CLICK leaves. Hovering reveals the cards the cap hid, on the
 * wall window -- it navigates nothing, opens nothing and steals no focus.
 * Clicking the head opens the epic in the MAIN window, and clicking a card line
 * does the same one level down. THE WALL is a driver, not a destination.
 *
 * The project chip is a SIBLING button, not one nested in the row's button: a
 * button inside a button is invalid, and the chip's job (filter the whole wall)
 * is the opposite of the row's (leave for the main window).
 */

import { MARKER, type PinnedChildRow } from '@shared/pinned-epic-rows'
import { useState } from 'react'
import { formatAgeShort } from '@/lib/status-style'
import { cn } from '@/lib/utils'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { ProjectTag } from '../project-tag'
import type { WallPinRow } from './use-wall-pins'
import { navigateFromWall } from './wall-navigate'

const MARKER_TONE: Record<string, string> = {
  [MARKER.moving]: 'text-accent',
  [MARKER.parked]: 'text-event-prompt',
  [MARKER.blocked]: 'text-fg-dim',
}

function ChildLine({ row, project }: { row: PinnedChildRow; project: string }) {
  return (
    <button
      type="button"
      title="Click -- the MAIN window opens this card"
      onClick={() => navigateFromWall({ kind: 'card', project, id: row.slug })}
      className="wall-pin-kid"
    >
      <span className={cn('wall-pin-marker', MARKER_TONE[row.marker])}>{row.marker}</span>
      <span className="wall-pin-kid-name">{row.title}</span>
      <span className="wall-pin-kid-lane">
        {row.lane}
        {row.mtime > 0 && ` · ${formatAgeShort(row.mtime)}`}
      </span>
    </button>
  )
}

export function PinnedEpicRow({ row }: { row: WallPinRow }) {
  const toggleProject = useWallFilterStore(s => s.toggleProject)
  const [hovered, setHovered] = useState(false)

  // THE PREVIEW: the capped remainder, revealed in place. Moving the pointer
  // away puts it back, and nothing else on the panel moved.
  const visible = hovered ? row.children : row.children.slice(0, row.cap)

  return (
    <div
      className="wall-pin"
      data-epic={row.epicId}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="wall-pin-head">
        <button
          type="button"
          title={`Filter the whole wall to ${row.projectName}`}
          onClick={() => toggleProject(row.projectName)}
          className="wall-pin-proj"
        >
          <ProjectTag name={row.projectName} icon={row.projectIcon} color={row.projectColor} />
        </button>
        <button
          type="button"
          title="Click -- the MAIN window opens this epic and raises itself. The wall stays put."
          onClick={() => navigateFromWall({ kind: 'epic', project: row.project, id: row.epicId })}
          className="wall-pin-open"
        >
          <span className="wall-pin-sep">::</span>
          <span className="wall-pin-epic">{row.epicTitle}</span>
          <span
            className="wall-pin-bar"
            role="progressbar"
            aria-valuenow={row.pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${row.epicTitle} progress`}
          >
            <i style={{ width: `${row.pct}%` }} />
          </span>
          <span className="wall-pin-frac">{`${row.done}/${row.total}`}</span>
          <span className="wall-pin-pct">{`${row.pct}%`}</span>
        </button>
      </div>

      {visible.map(kid => (
        <ChildLine key={kid.slug} row={kid} project={row.project} />
      ))}

      {/* NEVER a silent cap: a truncated list with no notice reads as "that is
          everything", which is the one thing it is not. */}
      {row.hidden > 0 && !hovered && <div className="wall-pin-more">{`+ ${row.hidden} more not closed`}</div>}
    </div>
  )
}
