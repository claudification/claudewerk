/**
 * Tiny helper for the useSyncExternalStore pattern used by ws-stats,
 * token-flow-store, and thinking-progress-store. All three have the same
 * subscribe / getVersion shape; centralizing it removes the boilerplate
 * triplication without forcing every store into a single all-purpose API.
 *
 * Each store creates its own ExternalStoreSignal, calls bump() on changes,
 * and exports the signal's subscribe / getVersion as its own exports.
 */

export interface ExternalStoreSignal {
  /** Notify all listeners on the next coalesced tick. */
  bump(): void
  /** useSyncExternalStore subscribe. */
  subscribe(fn: () => void): () => void
  /** useSyncExternalStore version-getter (stable primitive snapshot). */
  getVersion(): number
}

export function createExternalStoreSignal(): ExternalStoreSignal {
  let version = 0
  const listeners = new Set<() => void>()
  return {
    bump() {
      version++
      for (const fn of listeners) fn()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn) as unknown as undefined
    },
    getVersion() {
      return version
    },
  }
}
