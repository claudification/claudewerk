/**
 * Live "in 2 minutes" text, driven by ONE timer for the whole app.
 *
 * A schedule list can show dozens of next-run times at once; giving each row its
 * own `setInterval` means dozens of timers all waking the main thread on their
 * own phase. Instead there is a single 30s tick that every subscriber shares via
 * `useSyncExternalStore`, started on the first subscriber and cleared when the
 * last one unmounts.
 *
 * All the actual wording lives in `@shared/format-when` (pure, unit-tested); this
 * file only owns WHEN to re-render.
 */

import { formatRelative } from '@shared/format-when'
import { useSyncExternalStore } from 'react'

const TICK_MS = 30_000

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
/** Bumped each tick so `useSyncExternalStore` sees a changed snapshot. */
let tickCount = 0

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  if (timer === null) {
    timer = setInterval(() => {
      tickCount++
      for (const listener of listeners) listener()
    }, TICK_MS)
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

const getSnapshot = (): number => tickCount

/** Subscribe this component to the shared tick. Returns nothing useful by design. */
function useTick(): void {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Live-updating "in 2 minutes" / "2 minutes ago". Empty string for no target. */
export function useRelativeTime(targetMs: number | undefined | null): string {
  useTick()
  return targetMs == null ? '' : formatRelative(targetMs)
}

