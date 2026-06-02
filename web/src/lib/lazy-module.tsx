import { type ComponentType, lazy, type ReactNode, Suspense, useRef } from 'react'

/**
 * Defer a heavy modal/panel's JS chunk until it first needs to appear.
 *
 * THE PROBLEM these solve: the control panel's ~25 modals were rendered as
 * always-mounted siblings in the app root with STATIC imports, so their code
 * shipped in the eager `index` chunk even when the user never opened them.
 * `React.lazy` alone doesn't help -- a lazy element starts loading the moment
 * it renders, and these render unconditionally (they just return null when
 * closed).
 *
 * THE FIX: a tiny eager GATE subscribes to the modal's "should it be open?"
 * signal (`useArmed`). Until that first goes true the gate renders null and the
 * chunk is never fetched. Once armed it mounts the lazy body in Suspense and
 * KEEPS it mounted -- open/close stays the body's own concern, so close
 * animations and internal state survive a close.
 *
 * Keep `useArmed` cheap and eager (a store selector, or `bus.useArmed` from
 * createLazyBus) -- it is the one piece that stays in the index chunk.
 */
export function lazyModule<P extends object>(
  loader: () => Promise<{ default: ComponentType<P> }>,
  useArmed: () => boolean,
  fallback: ReactNode = null,
): ComponentType<P> {
  const Lazy = lazy(loader)
  return function LazyModuleGate(props: P) {
    const armed = useArmed()
    // Latch: once armed, stay mounted even if the signal flips back to false
    // (the body owns its own close). A ref is enough -- the `useArmed` render
    // that flipped `armed` true is the same render that reads the latch.
    const everArmed = useRef(false)
    if (armed) everArmed.current = true
    if (!everArmed.current) return null
    return (
      <Suspense fallback={fallback}>
        <Lazy {...props} />
      </Suspense>
    )
  }
}

/**
 * Adapt a named export to the default-export shape `React.lazy` requires.
 *   lazyModule(named(() => import('./foo'), 'Foo'), ...)
 */
export function named<M, K extends keyof M>(loader: () => Promise<M>, key: K): () => Promise<{ default: M[K] }> {
  return () => loader().then(m => ({ default: m[key] }))
}
