import { useSyncExternalStore } from 'react'

/**
 * A module-level open bus for a lazily-mounted modal/dialog.
 *
 * Many modals open imperatively: `openFoo(opts)` routes through a handler the
 * component registers on mount. That works only while the component is mounted
 * -- the whole point of lazy-loading is that it ISN'T until first opened, so a
 * naive lazy mount would drop the very open call that should reveal it.
 *
 * `createLazyBus` closes that gap. When `open()` is called and no handler is
 * registered yet, it BUFFERS the payload and arms the bus; the lazy gate
 * (see lazyModule) subscribes via `useArmed()`, mounts the body, and the body's
 * `setHandler` on mount REPLAYS the buffered open. Subsequent opens (handler
 * present) dispatch directly. One buffered open is retained -- the latest wins.
 */
export interface LazyBus<P> {
  /** Open the modal from anywhere. Buffers + arms if not yet mounted. */
  open(payload: P): void
  /** The component registers its real open handler on mount, clears on unmount.
   *  Registering replays a buffered open (so the just-mounted body reveals). */
  setHandler(fn: ((payload: P) => void) | null): void
  /** Hook for the lazy gate: true once an open has ever been requested. */
  useArmed(): boolean
}

export function createLazyBus<P>(): LazyBus<P> {
  let handler: ((payload: P) => void) | null = null
  let pending: { payload: P } | null = null
  let armed = false
  const subs = new Set<() => void>()
  const notify = () => {
    for (const fn of subs) fn()
  }

  return {
    open(payload) {
      if (handler) {
        handler(payload)
        return
      }
      // Not mounted yet: retain the latest open and wake the gate to mount.
      pending = { payload }
      if (!armed) {
        armed = true
        notify()
      }
    },
    setHandler(fn) {
      handler = fn
      if (fn && pending) {
        const { payload } = pending
        pending = null
        fn(payload)
      }
    },
    useArmed() {
      return useSyncExternalStore(
        cb => {
          subs.add(cb)
          return () => {
            subs.delete(cb)
          }
        },
        () => armed,
        () => armed,
      )
    },
  }
}
