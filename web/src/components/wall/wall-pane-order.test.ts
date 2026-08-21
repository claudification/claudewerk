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
 * (`.claude/temp/the-wall.html`), with TWO deliberate deviations recorded below --
 * both of them Jonas overriding column C on 2026-08-20.
 */

import { describe, expect, it } from 'vitest'
import { WALL_COLUMNS, type WallColumn } from './wall-pane-registry'

const codes = (col: WallColumn): string[] => WALL_COLUMNS[col].map(e => e.code)

describe('the wall pane order', () => {
  it('is the fixed v1 arrangement, column by column', () => {
    expect(codes('a')).toEqual(['P1', 'A8', 'A7'])
    expect(codes('b')).toEqual(['A1', 'P2', 'P3'])
    // A9 landed APPENDED, then MOVED up over the sheaf pair on Jonas's word
    // (2026-08-21) -- the third override of column C, asserted on its own below.
    expect(codes('c')).toEqual(['A2', 'S2', 'S1', 'P4', 'A9', 'A4', 'A6'])
  })

  it('keeps FLEET and HOST VITALS above the SHEAF (Jonas, 2026-08-20)', () => {
    // The mockup stacks A6 above S1 and P4. Jonas overrode that one line; this
    // is the assertion that stops the next pane insertion putting it back.
    const c = codes('c')
    expect(c.indexOf('P4')).toBeLessThan(c.indexOf('A6'))
    expect(c.indexOf('S1')).toBeLessThan(c.indexOf('A6'))
  })

  it('keeps the STATE OF THE UNION above the SHEAF (Jonas, 2026-08-20)', () => {
    // "SOTU need to be above SHEAF" -- the second override of the same day, and
    // the second line of column C that disagrees with the approved comp.
    const c = codes('c')
    expect(c.indexOf('A4')).toBeLessThan(c.indexOf('A6'))
  })

  it('leaves SOTU and the SHEAF as the bottom two of column C (Jonas, 2026-08-21)', () => {
    // "put this above state of the union? so SOTU and SHEAF are the bottom two
    // in that column" -- stated as a property of the FOOT of C rather than as
    // A9's index, because that is what he asked for: the next pane to land in C
    // must go above the pair, not under it, and appending would break this.
    expect(codes('c').slice(-2)).toEqual(['A4', 'A6'])
  })
})
