import { createEventBus } from '@/lib/lazy-event-bus'

/** Buffering bus bridging the `open-batch-selector` window event so the
 *  lazy-mounted TaskBatchSelector never misses the opening event. Dispatch
 *  sites (FAB, context menu, project board) keep firing the event unchanged. */
export const taskBatchBus = createEventBus<void>('open-batch-selector')
