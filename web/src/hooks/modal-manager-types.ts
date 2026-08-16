/**
 * Unified minimizable modals — shared types.
 *
 * Every managed modal is tagged on two axes: an OWNER SCOPE (what context it
 * belongs to, which drives restore-warps-to-owner) and a MINIMIZE POLICY
 * (`minimizable` -> parkable; otherwise blocking). See plan-unified-modals.md.
 *
 * PRESENTATION is the single axis for WHERE the body renders right now --
 * `inline` (Radix Dialog in the main tab), `docked` (parked to the dock, body
 * still mounted), or `detached` (portaled into its own OS window via the
 * PopoutWindow primitive). It subsumes the old open/minimized phase plus detach;
 * `maximized` stays orthogonal and only matters when `inline`.
 */

/** What a modal belongs to. `global` modals never warp on restore. */
export type ModalScope = { type: 'global' } | { type: 'project'; uri: string } | { type: 'conversation'; id: string }

/**
 * Where the modal renders. A record absent from the store means CLOSED.
 * - `inline`   — Radix Dialog in the main tab (+ optional maximized).
 * - `docked`   — parked tile in the global dock; the body's canvas moves to the
 *                offscreen stash and keeps running (state survives).
 * - `detached` — portaled into its own OS window (window held in the manager's registry).
 */
export type ModalPresentation = 'inline' | 'docked' | 'detached'

export interface ModalRecord {
  /** Stable instance id (singleton: the kind; multi-instance: `${kind}:${scopeKey}`). */
  id: string
  /** Modal family, for grouping/labels. */
  kind: string
  /** Dock label — the modal's own name (e.g. "Debug: control"). */
  title: string
  scope: ModalScope
  /** false = blocking (no minimize/detach, never reaches the dock). */
  minimizable: boolean
  presentation: ModalPresentation
  /** Fill-the-window state, orthogonal to presentation. Preserved across transitions. */
  maximized: boolean
  /** Wall-clock open time, for dock ordering. */
  openedAt: number
}

export interface ManagedModalOpts {
  id: string
  kind: string
  title: string
  /** Default true. Pass false for blocking modals. */
  minimizable?: boolean
}
