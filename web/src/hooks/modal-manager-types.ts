/**
 * Unified minimizable modals — shared types.
 *
 * Every managed modal is tagged on two axes: an OWNER SCOPE (what context it
 * belongs to, which drives restore-warps-to-owner) and a MINIMIZE POLICY
 * (`minimizable` -> parkable; otherwise blocking). See plan-unified-modals.md.
 */

/** What a modal belongs to. `global` modals never warp on restore. */
export type ModalScope = { type: 'global' } | { type: 'project'; uri: string } | { type: 'conversation'; id: string }

/** A record absent from the store means the modal is CLOSED. */
export type ModalPhase = 'open' | 'minimized'

export interface ModalRecord {
  /** Stable instance id (singleton: the kind; multi-instance: `${kind}:${scopeKey}`). */
  id: string
  /** Modal family, for grouping/labels. */
  kind: string
  /** Dock label — the modal's own name (e.g. "Debug: control"). */
  title: string
  scope: ModalScope
  /** false = blocking (no minimize button, never reaches the dock). */
  minimizable: boolean
  phase: ModalPhase
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
