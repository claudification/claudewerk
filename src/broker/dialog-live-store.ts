/**
 * THE DIALOGUE (D1c) — broker-side live-dialog persistence helpers.
 *
 * The HOST owns the authoritative dialog snapshot; the broker persists it
 * OPAQUELY (never interprets layout/state/ops — it reads only `.status`/
 * `.dialogId`/`.seq` for lifecycle routing). These pure helpers synthesize the
 * initial slot, merge host snapshots into the single per-conversation slot, and
 * enforce broker byte caps. No broker-context dependency so they unit-test
 * standalone.
 */

import type { DialogSnapshot } from '../shared/dialog-live'
import type { DialogLayout } from '../shared/dialog-schema'

/**
 * Max bytes of a persisted host snapshot (R2#3 — refuse oversize blobs).
 * Headroom for one inline Draw block (tldraw snapshot up to DRAW_INLINE_MAX,
 * 256KB) plus the surrounding layout chrome. Larger drawings ride as a
 * contentUrl reference, so the persisted layout stays well under this.
 */
export const MAX_SNAPSHOT_BYTES = 512 * 1024
/**
 * Max bytes of an inbound dialog_event `state` payload (R2#3).
 * Raised for the Draw block: a single drawing may ride inline up to
 * DRAW_INLINE_MAX (256KB); above that the client spills it to a blob and sends
 * only a URL reference, so realistic states stay far below this ceiling. This
 * is the hard last-resort guard, not the expected size.
 */
export const MAX_EVENT_STATE_BYTES = 1024 * 1024

/** The single per-conversation live-dialog slot the broker persists. */
export interface LiveDialogSlot {
  dialogId: string
  snapshot: DialogSnapshot
  /** First-interactor-wins lock principal (single-interactor lock, R2#5). */
  interactor?: string
  /** Broker-stamped monotonic event-ordering token. */
  lastEventSeq?: number
  updatedAt: number
}

export function jsonBytes(value: unknown): number {
  return JSON.stringify(value ?? {}).length
}

export function withinSnapshotCap(snapshot: unknown): boolean {
  return jsonBytes(snapshot) <= MAX_SNAPSHOT_BYTES
}

export function withinEventStateCap(state: unknown): boolean {
  return jsonBytes(state) <= MAX_EVENT_STATE_BYTES
}

/**
 * Synthesize the initial slot for a freshly-shown persistent dialog. Mirrors
 * the host's OpenDialogRegistry.register (seq 0 / open / empty state) so the
 * broker has a record to replay before the first host patch arrives.
 */
export function initialLiveSlot(dialogId: string, layout: DialogLayout, now: number): LiveDialogSlot {
  return {
    dialogId,
    snapshot: { dialogId, layout, state: {}, seq: 0, status: 'open' },
    updatedAt: now,
  }
}

/**
 * Fold a host snapshot into the slot. The broker-owned lock fields (interactor,
 * lastEventSeq) survive a patch to the SAME dialogId but reset when a new
 * dialogId replaces the single slot — the binding is per-dialog and immutable
 * for that dialog's life.
 */
export function mergeLiveSlot(prev: LiveDialogSlot | undefined, snapshot: DialogSnapshot, now: number): LiveDialogSlot {
  const sameDialog = prev?.dialogId === snapshot.dialogId
  return {
    dialogId: snapshot.dialogId,
    snapshot,
    interactor: sameDialog ? prev?.interactor : undefined,
    lastEventSeq: sameDialog ? prev?.lastEventSeq : undefined,
    updatedAt: now,
  }
}
