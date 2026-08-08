import { type RefObject, useCallback, useEffect, useRef } from 'react'

/** Trailing-edge debounce that cancels on unmount.
 *
 *  The unmount clear is the point: a pending timer that fires after the dialog
 *  is gone sets state on a dead component. */
export function useDebounced(delayMs: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return useCallback(
    (fn: () => void) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(fn, delayMs)
    },
    [delayMs],
  )
}

/** Focus the input once the dialog has actually mounted.
 *
 *  The timer id is captured and cleared on cleanup: without that, closing the
 *  dialog inside the 50ms window leaves a timer that focuses a dead node. There
 *  is a regression test for exactly this. */
export function useFocusOnOpen(open: boolean): RefObject<HTMLInputElement | null> {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => ref.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open])
  return ref
}
