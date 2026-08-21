/**
 * "Am I still on screen?" -- what an async load asks before it calls `setState`.
 *
 * Every pull-fed thing on THE WALL has the same shape: fire a fetch, await it,
 * land the answer in component state. The await is where the component can go
 * away -- a surface transition (inline -> docked -> detached) unmounts the whole
 * tree, and a period change unmounts nothing but starts a second request whose
 * first answer must not be allowed to land after the second one. This is how the
 * landing site says whether it is still there.
 *
 * WHY A REF AND NOT A CANCEL. `fetch` here is fire-and-forget by design: the
 * revive ledger counts a pull as ISSUED the moment it starts, and an aborted
 * request that resolves as a rejection would read as "the broker did not answer"
 * rather than "we stopped caring". Checking at the landing site keeps the two
 * apart.
 *
 * WHY A FUNCTION AND NOT THE REF ITSELF. A returned `RefObject` reads as
 * `live.current` at the call site, and a `.current` that the linter cannot trace
 * back to a `useRef` in the same file becomes a phantom missing dependency on
 * every `useCallback` that reads it. The getter is stable for the life of the
 * component, so it lists cleanly in a dependency array and churns nothing.
 *
 * `useRef(true)` AND the effect, both. The initial `true` covers a load that
 * resolves before effects have run at all (a stubbed fetch in a test does exactly
 * this); the effect re-arms it for React's dev double-mount, where the first
 * cleanup has already written `false` into the ref the second mount inherits.
 */

import { useCallback, useEffect, useRef } from 'react'

/** A stable getter: true while this component is mounted. Call it after every
 *  `await`, before every `setState`. */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback(() => mounted.current, [])
}
