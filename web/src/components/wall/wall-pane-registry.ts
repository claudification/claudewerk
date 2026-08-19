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

export type WallColumn = 'a' | 'b' | 'c'

export interface WallPaneEntry {
  /** Reference code from the mockup. How a human and an agent point at a pane. */
  code: string
  load: () => Promise<{ default: ComponentType }>
}

export const WALL_COLUMNS: Record<WallColumn, WallPaneEntry[]> = {
  a: [
    { code: 'P1', load: () => import('./panes/p1-pulse') },
    // A8 sits between PULSE and the runs, exactly where the approved mockup puts
    // it. It was not one of the twelve stubs this registry shipped with, so
    // `wall-pane-pinned-epics` is the one pane card that also edits this file.
    { code: 'A8', load: () => import('./panes/a8-pinned') },
    { code: 'A7', load: () => import('./panes/a7-unattended-runs') },
  ],
  b: [
    { code: 'A1', load: () => import('./panes/a1-attention') },
    { code: 'P2', load: () => import('./panes/p2-commit-river') },
    { code: 'P3', load: () => import('./panes/p3-card-ledger') },
  ],
  c: [
    { code: 'A2', load: () => import('./panes/a2-burn') },
    { code: 'S2', load: () => import('./panes/s2-plan-usage') },
    { code: 'A6', load: () => import('./panes/a6-sheaf') },
    { code: 'S1', load: () => import('./panes/s1-host-vitals') },
    { code: 'P4', load: () => import('./panes/p4-fleet') },
    { code: 'A4', load: () => import('./panes/a4-sotu') },
  ],
}

/** A5 is not in a column -- it is the strip between the header and the grid. */
export const NOW_BAR: WallPaneEntry = { code: 'A5', load: () => import('./panes/a5-now-bar') }

export const WALL_PANE_CODES: string[] = [
  ...Object.values(WALL_COLUMNS).flatMap(entries => entries.map(e => e.code)),
  NOW_BAR.code,
]
