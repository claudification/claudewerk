/**
 * THE HARD GRID -- the layout is data, and it is FIXED in v1.
 *
 * Every column, cap and reference code below is read straight off the approved
 * mockup (.claude/temp/the-wall.html). This is deliberately NOT a layout engine:
 * the epic says a configurable pane grid is FUTURE, so the shell owns one
 * hard-coded arrangement and each pane card fills in a `load`.
 *
 * `load` is a dynamic import per pane, so a pane that nobody scrolls to still
 * costs nothing until the surface mounts it. Until a pane card lands, every
 * entry points at the shared placeholder body -- swap YOUR pane's `load` and
 * nothing else moves.
 */

import type { ComponentType } from 'react'

export type WallColumn = 'a' | 'b' | 'c'

export interface WallPaneSpec {
  /** Reference code from the mockup (P1, A7, S2 ...). Rendered next to the title. */
  code: string
  title: string
  column: WallColumn
  /** Takes the leftover column height. At most one per non-scrolling column. */
  grow?: boolean
  /** Cap as a share of the column, straight from the mockup's inline styles. */
  maxHeight?: string
  /** The mockup's `.count` slot -- a static caption until a feed supplies one. */
  caption?: string
  /** Hidden in ambient mode. Prose nobody can read from across a room. */
  hideInAmbient?: boolean
  load: () => Promise<{ default: ComponentType }>
}

const placeholder = () => import('./wall-pane-placeholder')

export const WALL_PANES: WallPaneSpec[] = [
  { code: 'P1', title: 'PULSE', column: 'a', grow: true, load: placeholder },
  { code: 'A7', title: 'UNATTENDED RUNS', column: 'a', maxHeight: '38%', load: placeholder },

  { code: 'A1', title: 'BLOCKED ON YOU', column: 'b', maxHeight: '34%', load: placeholder },
  { code: 'P2', title: 'COMMIT RIVER', column: 'b', grow: true, load: placeholder },
  { code: 'P3', title: 'CARD LEDGER', column: 'b', maxHeight: '32%', load: placeholder },

  { code: 'A2', title: 'BURN', column: 'c', caption: 'last 60m', load: placeholder },
  { code: 'S2', title: 'PLAN USAGE', column: 'c', caption: '5h window', load: placeholder },
  { code: 'A6', title: 'SHEAF', column: 'c', load: placeholder },
  { code: 'S1', title: 'HOST VITALS', column: 'c', load: placeholder },
  { code: 'P4', title: 'FLEET', column: 'c', load: placeholder },
  { code: 'A4', title: 'STATE OF THE UNION', column: 'c', hideInAmbient: true, load: placeholder },
]

export function panesInColumn(column: WallColumn): WallPaneSpec[] {
  return WALL_PANES.filter(p => p.column === column)
}
