/**
 * THE STUB REGISTRY -- the file that lets twelve pane cards run at once.
 *
 * Twelve worktrees land after this one, in parallel. If a pane card had to add
 * itself to the grid, twelve agents would edit one file and every merge after
 * the first would conflict. So every pane already exists as a stub under
 * `panes/`, already wired HERE, and a pane card rewrites exactly ONE stub file
 * and touches no shared file at all.
 *
 * That is also why this file holds nothing but a code, a column and a path.
 * Title, sizing, tabs, counts and the ambient opt-out all live in the stub, on
 * its own <WallPane> -- otherwise "rewrite one file" would be a lie.
 *
 * `load` is a per-pane dynamic import(), so the wall's own chunk carries the
 * frame and nothing else.
 *
 * THE LAYOUT IS HARD in v1. This is a fixed arrangement read off the approved
 * mockup, not a layout engine; the epic defers a configurable grid to FUTURE.
 */

import type { ComponentType } from 'react'
import type { WallFeedId } from '@/lib/wall/revive-store'

export type WallColumn = 'a' | 'b' | 'c'

export interface WallPaneEntry {
  /** Reference code from the mockup. How a human and an agent point at a pane. */
  code: string
  /**
   * The PULL-fed sources behind this pane. `[]` = everything it shows rides the
   * wall channel or the conversation registry, both of which already revive.
   *
   * REQUIRED, and that is the point: the resilience card's census is folded out
   * of this table, so the next pane cannot silently opt out of reviving after a
   * disconnect -- it does not compile until it says what feeds it.
   */
  feeds: readonly WallFeedId[]
  load: () => Promise<{ default: ComponentType }>
}

export const WALL_COLUMNS: Record<WallColumn, WallPaneEntry[]> = {
  a: [
    { code: 'P1', feeds: [], load: () => import('./panes/p1-pulse') },
    // A8 sits between PULSE and the runs, exactly where the approved mockup puts
    // it. It was not one of the twelve stubs this registry shipped with, so
    // `wall-pane-pinned-epics` is the one pane card that also edits this file.
    { code: 'A8', feeds: ['pins'], load: () => import('./panes/a8-pinned') },
    { code: 'A7', feeds: ['runs'], load: () => import('./panes/a7-unattended-runs') },
  ],
  b: [
    { code: 'A1', feeds: [], load: () => import('./panes/a1-attention') },
    { code: 'P2', feeds: ['commits'], load: () => import('./panes/p2-commit-river') },
    { code: 'P3', feeds: [], load: () => import('./panes/p3-card-ledger') },
  ],
  c: [
    { code: 'A2', feeds: ['burn'], load: () => import('./panes/a2-burn') },
    { code: 'S2', feeds: [], load: () => import('./panes/s2-plan-usage') },
    // DEVIATION FROM THE MOCKUP, on Jonas's word (2026-08-20): "Fleet + host
    // vitals should be above SHEAF". The comp stacks A6 first, then S1, then P4.
    // The pair moved up as a pair, keeping the comp's S1-before-P4 order, so the
    // only line that disagrees with the approved comp is the one he overrode.
    // Still a fixed arrangement -- `wall-pane-order.test.ts` pins it.
    { code: 'S1', feeds: [], load: () => import('./panes/s1-host-vitals') },
    { code: 'P4', feeds: ['fleet-tokens'], load: () => import('./panes/p4-fleet') },
    { code: 'A6', feeds: ['sheaf'], load: () => import('./panes/a6-sheaf') },
    { code: 'A4', feeds: ['sheaf'], load: () => import('./panes/a4-sotu') },
  ],
}

/** A5 is not in a column -- it is the strip between the header and the grid. */
export const NOW_BAR: WallPaneEntry = { code: 'A5', feeds: [], load: () => import('./panes/a5-now-bar') }

/** Module-internal: the flat fold the two exported censuses below are built from.
 *  Not exported until something outside this file actually reads it -- an export
 *  with no consumer is the shape fallow's dead-code gate exists to catch. The
 *  cross-pane proof is the likely first caller; re-export it there, with the test
 *  that needs it. */
const WALL_PANE_ENTRIES: WallPaneEntry[] = [...Object.values(WALL_COLUMNS).flat(), NOW_BAR]

export const WALL_PANE_CODES: string[] = WALL_PANE_ENTRIES.map(e => e.code)

/**
 * THE CENSUS. Every pull-fed source the surface carries, folded out of the table
 * above rather than typed out beside it -- a second hand-maintained list is a
 * list that goes stale the first time somebody adds a pane in a hurry.
 */
export const WALL_PULL_FEEDS: ReadonlySet<WallFeedId> = new Set(WALL_PANE_ENTRIES.flatMap(e => e.feeds))
