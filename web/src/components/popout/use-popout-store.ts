/**
 * Popout registry. ONE record per open popout window. open() runs INSIDE the
 * triggering click so window.open keeps its user-gesture (popup blockers allow a
 * same-origin blank window opened synchronously from a gesture); the live Window
 * is held here and rendered into by <PopoutHost> via <PopoutWindow>.
 *
 * Heavy per-kind surfaces (Excalidraw, xterm, ...) stay behind PopoutHost's lazy
 * imports -- this store only tracks {kind, payloadId, win}.
 */

import { create } from 'zustand'

export type PopoutKind = 'canvas'

export interface PopoutRecord {
  id: string
  kind: PopoutKind
  payloadId: string
  win: Window
}

interface PopoutOpts {
  width?: number
  height?: number
}

interface PopoutState {
  records: Record<string, PopoutRecord>
  /** Open (or focus) a popout. Returns the Window, or null if the browser blocked it. */
  open: (kind: PopoutKind, payloadId: string, opts?: PopoutOpts) => Window | null
  close: (id: string) => void
}

const popoutId = (kind: PopoutKind, payloadId: string) => `popout-${kind}-${payloadId}`
const features = (opts?: PopoutOpts) => `popup=yes,width=${opts?.width ?? 900},height=${opts?.height ?? 640}`

// Cross-window calls throw on a window the user already closed -- swallow it.
const focusSafe = (win: Window) => {
  try {
    win.focus()
  } catch {}
}
const closeSafe = (win: Window) => {
  try {
    if (!win.closed) win.close()
  } catch {}
}

export const usePopoutStore = create<PopoutState>((set, get) => ({
  records: {},

  open: (kind, payloadId, opts) => {
    const id = popoutId(kind, payloadId)
    const existing = get().records[id]
    if (existing && !existing.win.closed) {
      focusSafe(existing.win)
      return existing.win
    }
    const win = window.open('', id, features(opts))
    if (!win) return null
    focusSafe(win)
    set(state => ({ records: { ...state.records, [id]: { id, kind, payloadId, win } } }))
    return win
  },

  close: id =>
    set(state => {
      const rec = state.records[id]
      if (!rec) return state
      closeSafe(rec.win)
      const { [id]: _gone, ...records } = state.records
      return { records }
    }),
}))
