import type React from 'react'
import { useEffect, useRef } from 'react'

interface ComposeTimersResult {
  composeTimersRef: React.RefObject<Set<ReturnType<typeof setTimeout>>>
  composeTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearComposeTimers: () => void
}

export function useComposeTimers(): ComposeTimersResult {
  const composeTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())

  function composeTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      composeTimersRef.current.delete(id)
      fn()
    }, ms)
    composeTimersRef.current.add(id)
    return id
  }

  function clearComposeTimers() {
    for (const id of composeTimersRef.current) clearTimeout(id)
    composeTimersRef.current.clear()
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on unmount, clearComposeTimers is a stable function defined in this scope
  useEffect(() => {
    return () => clearComposeTimers()
  }, [])

  return { composeTimersRef, composeTimeout, clearComposeTimers }
}
