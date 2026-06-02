import { createEventBus } from '@/lib/lazy-event-bus'

/** "View past recaps..." -- opens the recap-history modal (Phase 10). */
export function openRecapHistory(projectUri?: string) {
  window.dispatchEvent(new CustomEvent('rclaude-recap-history-open', { detail: { projectUri } }))
}

/** Buffering bus bridging `rclaude-recap-history-open` so the lazy-mounted
 *  RecapHistoryModal never misses the opening event. */
export const recapHistoryBus = createEventBus<{ projectUri?: string } | undefined>('rclaude-recap-history-open')
