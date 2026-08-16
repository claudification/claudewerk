/**
 * Unified minimizable modals — the manager store.
 *
 * One record per live modal instance, keyed by a stable id. Components stay
 * mounted at the app shell and read their `presentation` from here; park, detach
 * and reattach only re-target WHERE the body's canvas is appended (Dialog <->
 * stash <-> OS window), so in-progress state survives every transition. The
 * mechanism that makes that true is the surface canvas, NOT this store -- see
 * components/surface/surface-canvas.ts. restore = warp to owner, then reopen.
 *
 * A detached modal's live `Window` and a surface's canvas are both
 * non-serializable, so they live in module-scoped Maps (NOT on the
 * future-persistable record); `getDetachedWindow()` reads the window on the
 * render the presentation flip triggers.
 */

import { create } from 'zustand'
import { disposeSurfaceCanvas } from '@/components/surface/surface-canvas'
import type { ManagedModalOpts, ModalPresentation, ModalRecord, ModalScope } from './modal-manager-types'
import { useConversationsStore } from './use-conversations'

/** Live popup windows for detached modals, by modal id. Off-record (non-serializable). */
const detachedWindows = new Map<string, Window>()

/** The popup window hosting a detached modal, or undefined when not detached. */
export function getDetachedWindow(id: string): Window | undefined {
  return detachedWindows.get(id)
}

const detachFeatures = 'popup=yes,width=900,height=640'

function closeWindowSafe(id: string): void {
  const win = detachedWindows.get(id)
  if (win) {
    try {
      if (!win.closed) win.close()
    } catch {}
    detachedWindows.delete(id)
  }
}

interface ModalManagerState {
  records: Record<string, ModalRecord>
  /** Open (or re-open) an instance inline, (re)capturing its owner scope. */
  open: (opts: ManagedModalOpts, scope: ModalScope) => void
  /** Park a parkable instance into the dock (no-op for blocking modals). */
  minimize: (id: string) => void
  /** Warp to the owner context, then re-open inline (dock restore). */
  restore: (id: string) => void
  /** Detach into its own OS window. MUST run inside the triggering click gesture. */
  detach: (id: string) => void
  /** Re-attach a detached modal back inline (closes the window). */
  reattach: (id: string) => void
  /** The popup window was closed by its own chrome -> park to the dock (keep state). */
  parkFromDetached: (id: string) => void
  /** Toggle the fill-the-window state (persisted across transitions). */
  toggleMaximize: (id: string) => void
  /** Drop the instance entirely (Escape / explicit close); closes any window. */
  close: (id: string) => void
}

/** Navigate the app to a modal's owner context. Global = stay put. */
function warpToScope(scope: ModalScope): void {
  const conv = useConversationsStore.getState()
  if (scope.type === 'conversation') {
    if (conv.selectedConversationId !== scope.id) conv.selectConversation(scope.id, 'modal-restore')
  } else if (scope.type === 'project') {
    if (conv.selectedProjectUri !== scope.uri) conv.selectProject(scope.uri)
  }
}

/** Set one record's presentation, if it exists. */
function setPresentation(
  state: ModalManagerState,
  id: string,
  presentation: ModalPresentation,
): Partial<ModalManagerState> {
  const cur = state.records[id]
  if (!cur) return state
  return { records: { ...state.records, [id]: { ...cur, presentation } } }
}

export const useModalManagerStore = create<ModalManagerState>((set, get) => ({
  records: {},

  open: (opts, scope) =>
    set(state => {
      const prev = state.records[opts.id]
      const record: ModalRecord = {
        id: opts.id,
        kind: opts.kind,
        title: opts.title,
        minimizable: opts.minimizable ?? true,
        scope,
        presentation: 'inline',
        maximized: prev?.maximized ?? false,
        openedAt: prev?.openedAt ?? Date.now(),
      }
      return { records: { ...state.records, [opts.id]: record } }
    }),

  minimize: id =>
    set(state => {
      const prev = state.records[id]
      // Blocking modals never park; a no-op keeps callers honest.
      if (!prev?.minimizable || prev.presentation === 'docked') return state
      return setPresentation(state, id, 'docked')
    }),

  restore: id => {
    const prev = get().records[id]
    if (!prev) return
    // Warp FIRST so the modal re-opens against its owning context.
    warpToScope(prev.scope)
    set(state => setPresentation(state, id, 'inline'))
  },

  detach: id => {
    const prev = get().records[id]
    if (!prev?.minimizable || prev.presentation === 'detached') return
    // window.open MUST be synchronous in the gesture for popup blockers to allow it.
    const win = window.open('', id, detachFeatures)
    if (!win) return // blocked -> stay where we were
    try {
      win.focus()
    } catch {}
    detachedWindows.set(id, win)
    set(state => setPresentation(state, id, 'detached'))
  },

  reattach: id =>
    set(state => {
      closeWindowSafe(id)
      return setPresentation(state, id, 'inline')
    }),

  parkFromDetached: id =>
    set(state => {
      detachedWindows.delete(id)
      return setPresentation(state, id, 'docked')
    }),

  toggleMaximize: id =>
    set(state => {
      const prev = state.records[id]
      if (!prev) return state
      return { records: { ...state.records, [id]: { ...prev, maximized: !prev.maximized } } }
    }),

  close: id =>
    set(state => {
      if (!state.records[id]) return state
      closeWindowSafe(id)
      // Closed is not parked: drop the canvas so a re-open starts on a genuinely
      // fresh body instead of resurrecting the one the user just dismissed.
      disposeSurfaceCanvas(id)
      const { [id]: _gone, ...records } = state.records
      return { records }
    }),
}))

export interface ManagedModal {
  /** Stable instance id (for reading the detached window via getDetachedWindow). */
  id: string
  /** 'closed' | 'inline' | 'docked' | 'detached'. */
  presentation: 'closed' | ModalPresentation
  scope: ModalScope | undefined
  minimizable: boolean
  /** Fill-the-window state, preserved across transitions. */
  maximized: boolean
  open: (scope: ModalScope) => void
  minimize: () => void
  restore: () => void
  detach: () => void
  reattach: () => void
  parkFromDetached: () => void
  toggleMaximize: () => void
  close: () => void
}

/**
 * Bind a modal component to the manager. Returns the live `presentation` plus
 * stable controls. The component renders via <ModalSurface>, which routes its
 * body to a Dialog (inline) / dock (docked) / PopoutWindow (detached).
 */
export function useManagedModal(opts: ManagedModalOpts): ManagedModal {
  const record = useModalManagerStore(s => s.records[opts.id])
  const minimizable = opts.minimizable ?? true
  const store = useModalManagerStore.getState
  return {
    id: opts.id,
    presentation: record?.presentation ?? 'closed',
    scope: record?.scope,
    minimizable,
    maximized: record?.maximized ?? false,
    open: scope => store().open(opts, scope),
    minimize: () => store().minimize(opts.id),
    restore: () => store().restore(opts.id),
    detach: () => store().detach(opts.id),
    reattach: () => store().reattach(opts.id),
    parkFromDetached: () => store().parkFromDetached(opts.id),
    toggleMaximize: () => store().toggleMaximize(opts.id),
    close: () => store().close(opts.id),
  }
}
