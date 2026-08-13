import { createEventBus } from '@/lib/lazy-event-bus'

/**
 * What a dispatch site can hand the selector. `undefined` (the historical
 * payload) means "open empty", which is what every pre-existing call site does.
 *
 * `preselect` is the whole reason this grew a payload: opening the selector
 * from an epic with nothing ticked makes you re-find the cards you just looked
 * at. The epic already knows which ones have not been started.
 */
export interface TaskBatchOpen {
  /** Card ids to tick on open. */
  preselect?: string[]
  /** Restrict the visible list to these ids. Omit to show the whole board. */
  scope?: string[]
  /** Shown in the header so it is obvious the list is not the whole board. */
  scopeLabel?: string
}

/** Buffering bus bridging the `open-batch-selector` window event so the
 *  lazy-mounted TaskBatchSelector never misses the opening event. Dispatch
 *  sites (FAB, context menu, project board) keep firing the event unchanged. */
export const taskBatchBus = createEventBus<TaskBatchOpen | undefined>('open-batch-selector')

/** Open the selector already scoped and ticked. */
export function openTaskBatch(detail?: TaskBatchOpen) {
  window.dispatchEvent(new CustomEvent('open-batch-selector', { detail }))
}
