import { createLazyBus, type LazyBus } from './lazy-bus'

/**
 * Bridge a window CustomEvent to a buffering lazy bus.
 *
 * Several modals open via `window.dispatchEvent(new CustomEvent(name, {detail}))`
 * fired from many call sites (FABs, context menus, transcript links, tests). To
 * lazy-mount such a modal we can't simply let it listen on mount -- the opening
 * event fires while it's still unmounted and would be missed.
 *
 * This installs ONE tiny eager window listener (created when the trigger module
 * loads) that forwards every matching event INTO a createLazyBus: if the body
 * is mounted it dispatches straight to its handler; if not, the bus buffers the
 * detail, arms the gate, and replays it once the body registers on mount.
 *
 * Net effect: every existing `dispatchEvent` site and test keeps working
 * unchanged -- only the lazy body swaps `window.addEventListener(name, fn)` for
 * `bus.setHandler(fn)` (its callback now takes the event detail, not the event).
 */
export function createEventBus<D = void>(eventNames: string | string[]): LazyBus<D> {
  const bus = createLazyBus<D>()
  const names = Array.isArray(eventNames) ? eventNames : [eventNames]
  if (typeof window !== 'undefined') {
    for (const name of names) {
      window.addEventListener(name, event => {
        bus.open((event as CustomEvent<D>).detail as D)
      })
    }
  }
  return bus
}
