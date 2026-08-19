/**
 * The wall's local tick.
 *
 * Every pane re-renders when a frame arrives. Staleness is the opposite case: a
 * thing goes grey precisely BECAUSE no frame came in, so a pane that only
 * re-renders on data would keep a dead box looking alive forever. Hence a local
 * clock rather than anything on the wire -- the broker cannot send "still
 * nothing" frames, and asking it to would be a heartbeat about a heartbeat.
 *
 * The interval is the caller's: a pane whose ages are measured in minutes has no
 * business ticking every second. Each pane names its own default and its own
 * reason at the seam it owns; only the mechanism lives here.
 */

import { useEffect, useState } from 'react'

export function useWallClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
