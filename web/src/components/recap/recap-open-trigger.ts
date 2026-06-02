import { createEventBus } from '@/lib/lazy-event-bus'

/** Buffering bus bridging the `rclaude-recap-open` window event so the
 *  lazy-mounted RecapViewer never misses the opening event. Dispatch sites
 *  (transcript links, recap widgets, history modal) keep firing the event. */
export const recapOpenBus = createEventBus<{ recapId?: string } | undefined>('rclaude-recap-open')
