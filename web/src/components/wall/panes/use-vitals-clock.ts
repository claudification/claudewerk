/**
 * A once-a-second clock, for the one thing on S1 that has to change when NOTHING
 * arrives.
 *
 * Every other pane re-renders because a frame came in. Staleness is the opposite
 * case: a node goes grey precisely because no frame came in, so a pane that only
 * re-renders on data would keep a dead box looking alive forever. Hence a local
 * tick rather than anything on the wire -- the broker cannot send "still nothing"
 * frames, and asking it to would be a heartbeat about a heartbeat.
 */

import { useEffect, useState } from 'react'

export function useVitalsClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
