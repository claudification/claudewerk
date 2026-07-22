/**
 * Per-document save-state store, kept OUTSIDE React render state on purpose.
 *
 * The save indicator flips idle -> saving -> saved on every persist. If that
 * lived in the canvas surface's React state, each flip would re-render the
 * Excalidraw wrapper -- churning the tool palette AND (because Excalidraw
 * reports the re-render as an onChange) feeding the phantom-save loop. Holding
 * it in an external store means only the tiny orb that subscribes re-renders;
 * the drawing surface never sees a save happen.
 */

import { createExternalStoreSignal } from '@/hooks/external-store-utils'

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export interface SaveSnapshot {
  state: SaveState
  /** Human-readable failure reason, surfaced when the orb is clicked. */
  detail?: string
}

export interface SaveStateStore {
  subscribe(fn: () => void): () => void
  /** Stable snapshot reference between changes (useSyncExternalStore-safe). */
  get(): SaveSnapshot
  set(state: SaveState, detail?: string): void
}

const IDLE: SaveSnapshot = { state: 'idle' }

export function createSaveStateStore(): SaveStateStore {
  const signal = createExternalStoreSignal()
  let snap: SaveSnapshot = IDLE
  return {
    subscribe: signal.subscribe,
    get: () => snap,
    set(state, detail) {
      if (snap.state === state && snap.detail === detail) return
      snap = detail === undefined ? { state } : { state, detail }
      signal.bump()
    },
  }
}
