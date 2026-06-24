/**
 * Unified minimizable modals — the manager store.
 *
 * One record per open/minimized modal instance, keyed by a stable id. Modal
 * components stay mounted at the app shell and read their `phase` from here
 * instead of a local `useState(open)`; `minimized` keeps the component mounted
 * with the Radix Dialog closed (in-progress local state survives for free) and
 * surfaces a tile in the global ModalDock.
 *
 * THE rule — restore = warp to owner, then reopen: a parked conversation/project
 * modal is meaningless outside its owner's context, so restoring one from another
 * context first navigates back to the owner. See plan-unified-modals.md.
 */

import { create } from 'zustand'
import type { ManagedModalOpts, ModalPhase, ModalRecord, ModalScope } from './modal-manager-types'
import { useConversationsStore } from './use-conversations'

interface ModalManagerState {
  records: Record<string, ModalRecord>
  /** Open (or re-open) an instance, (re)capturing its owner scope. */
  open: (opts: ManagedModalOpts, scope: ModalScope) => void
  /** Park a parkable instance into the dock (no-op for blocking modals). */
  minimize: (id: string) => void
  /** Warp to the owner context, then re-open. */
  restore: (id: string) => void
  /** Drop the instance entirely (Escape / explicit close). */
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
        phase: 'open',
        openedAt: prev?.openedAt ?? Date.now(),
      }
      return { records: { ...state.records, [opts.id]: record } }
    }),

  minimize: id =>
    set(state => {
      const prev = state.records[id]
      // Blocking modals never park; a no-op keeps callers honest.
      if (!prev?.minimizable || prev.phase === 'minimized') return state
      return { records: { ...state.records, [id]: { ...prev, phase: 'minimized' as ModalPhase } } }
    }),

  restore: id => {
    const prev = get().records[id]
    if (!prev) return
    // Warp FIRST so the modal re-opens against its owning context.
    warpToScope(prev.scope)
    set(state => {
      const cur = state.records[id]
      if (!cur) return state
      return { records: { ...state.records, [id]: { ...cur, phase: 'open' as ModalPhase } } }
    })
  },

  close: id =>
    set(state => {
      if (!state.records[id]) return state
      const { [id]: _gone, ...records } = state.records
      return { records }
    }),
}))

export interface ManagedModal {
  /** 'closed' | 'open' | 'minimized'. */
  phase: 'closed' | ModalPhase
  scope: ModalScope | undefined
  minimizable: boolean
  open: (scope: ModalScope) => void
  minimize: () => void
  close: () => void
}

/**
 * Bind a modal component to the manager. Returns the live `phase` plus stable
 * controls. The component renders its Radix Dialog `open={phase === 'open'}`,
 * wires the new minimize button to `minimize()`, and Escape/x to `close()`.
 */
export function useManagedModal(opts: ManagedModalOpts): ManagedModal {
  const record = useModalManagerStore(s => s.records[opts.id])
  const minimizable = opts.minimizable ?? true
  return {
    phase: record?.phase ?? 'closed',
    scope: record?.scope,
    minimizable,
    open: scope => useModalManagerStore.getState().open(opts, scope),
    minimize: () => useModalManagerStore.getState().minimize(opts.id),
    close: () => useModalManagerStore.getState().close(opts.id),
  }
}
