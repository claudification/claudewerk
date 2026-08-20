/**
 * THE HARD GRID's ORDER, pinned.
 *
 * `wall-surface.test.tsx` proves every registered pane mounts and that column C
 * holds six of them; neither claim notices a re-sort. This file is the one that
 * does. Thirteen panes landed from thirteen worktrees, and the fourteenth pane
 * card will append to whichever column it fits -- an append is fine, a silent
 * shuffle of what is already there is not.
 *
 * The order is a fixed v1 arrangement read off the approved mockup
 * (`.claude/temp/the-wall.html`), with ONE deliberate deviation recorded below.
 */

import { describe, expect, it } from 'vitest'
import { WALL_COLUMNS, type WallColumn } from './wall-pane-registry'

const codes = (col: WallColumn): string[] => WALL_COLUMNS[col].map(e => e.code)

describe('the wall pane order', () => {
  it('is the fixed v1 arrangement, column by column', () => {
    expect(codes('a')).toEqual(['P1', 'A8', 'A7'])
    expect(codes('b')).toEqual(['A1', 'P2', 'P3'])
    expect(codes('c')).toEqual(['A2', 'S2', 'S1', 'P4', 'A6', 'A4'])
  })

  it('keeps FLEET and HOST VITALS above the SHEAF (Jonas, 2026-08-20)', () => {
    // The mockup stacks A6 above S1 and P4. Jonas overrode that one line; this
    // is the assertion that stops the next pane insertion putting it back.
    const c = codes('c')
    expect(c.indexOf('P4')).toBeLessThan(c.indexOf('A6'))
    expect(c.indexOf('S1')).toBeLessThan(c.indexOf('A6'))
  })
})
