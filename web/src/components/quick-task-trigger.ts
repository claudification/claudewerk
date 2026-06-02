import { createEventBus } from '@/lib/lazy-event-bus'

/** Buffering bus bridging the `open-quick-task` window event so the lazy-mounted
 *  QuickTaskModal never misses the opening event. Dispatch sites (action FAB,
 *  command palette) keep firing the window event unchanged. */
export const quickTaskBus = createEventBus<void>('open-quick-task')
