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
 * The store holds INTENTS. Record shaping lives in modal-records.ts, the live
 * popup windows in modal-windows.ts, and the activity rules in
 * surface-activity.ts -- all three because they are non-serializable, pure, or
 * both, and none of them are a state machine.
 */

import { create } from 'zustand'
import { disposeSurfaceCanvas } from '@/components/surface/surface-canvas'
import type {
  ManagedModalOpts,
  ModalPresentation,
  ModalRecord,
  ModalScope,
  SurfaceActivity,
  SurfaceActivityInput,
} from './modal-manager-types'
import { newRecord, warpToScope, withPresentation, withSeen } from './modal-records'
import { closeDetachedWindow, forgetDetachedWindow, getDetachedWindow, openDetachedWindow } from './modal-windows'
import { nextActivity, sameActivity } from './surface-activity'

export { getDetachedWindow }

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
  /** A surface reporting what it is doing. OPT-IN: never called = never shown. */
  reportActivity: (id: string, input: SurfaceActivityInput) => void
}

export const useModalManagerStore = create<ModalManagerState>((set, get) => ({
  records: {},

  open: (opts, scope) =>
    set(state => ({ records: { ...state.records, [opts.id]: newRecord(opts, scope, state.records[opts.id]) } })),

  minimize: id =>
    set(state => {
      const prev = state.records[id]
      // Blocking modals never park; a no-op keeps callers honest.
      if (!prev?.minimizable || prev.presentation === 'docked') return state
      return { records: withPresentation(state.records, id, 'docked') }
    }),

  restore: id => {
    const prev = get().records[id]
    if (!prev) return
    // Warp FIRST so the modal re-opens against its owning context.
    warpToScope(prev.scope)
    set(state => ({ records: withSeen(withPresentation(state.records, id, 'inline'), id) }))
  },

  detach: id => {
    const prev = get().records[id]
    if (!prev?.minimizable || prev.presentation === 'detached') return
    // Blocked by the popup blocker -> stay where we were.
    if (!openDetachedWindow(id)) return
    set(state => ({ records: withPresentation(state.records, id, 'detached') }))
  },

  reattach: id =>
    set(state => {
      closeDetachedWindow(id)
      return { records: withPresentation(state.records, id, 'inline') }
    }),

  parkFromDetached: id =>
    set(state => {
      forgetDetachedWindow(id)
      return { records: withPresentation(state.records, id, 'docked') }
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
      closeDetachedWindow(id)
      // Closed is not parked: drop the canvas so a re-open starts on a genuinely
      // fresh body instead of resurrecting the one the user just dismissed.
      disposeSurfaceCanvas(id)
      const { [id]: _gone, ...records } = state.records
      return { records }
    }),

  reportActivity: (id, input) =>
    set(state => {
      const cur = state.records[id]
      // No record = the surface is closed; nothing to report against.
      if (!cur || sameActivity(cur.activity, input)) return state
      const activity = nextActivity(cur.activity, input, cur.presentation, Date.now())
      return { records: { ...state.records, [id]: { ...cur, activity } } }
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
  /** What this surface last reported, if it reports at all. */
  activity: SurfaceActivity | undefined
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
    activity: record?.activity,
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
