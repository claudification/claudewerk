import { createEventBus } from '@/lib/lazy-event-bus'

export function openRenameModal(name?: string) {
  window.dispatchEvent(new CustomEvent('open-rename-modal', { detail: { name } }))
}

/** Buffering bus bridging `open-rename-modal` so the lazy-mounted RenameModal
 *  never misses the opening event. `openRenameModal` keeps dispatching the
 *  window event; the bridge forwards it into the bus. */
export const renameModalBus = createEventBus<{ name?: string } | undefined>('open-rename-modal')
