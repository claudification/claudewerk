/**
 * Drive the orb's halo off live audio: one rAF loop while the orb is up.
 *
 * Two deliberate economies, both learned from a Safari tab getting OOM-killed
 * with the orb open:
 *   - the meter reconciles streams by id, so a frame never allocates a new
 *     audio node (see audio-level.ts),
 *   - state only moves when the level moves VISIBLY. Re-rendering the host
 *     sixty times a second to nudge a CSS scale by 0.003 is pure waste.
 */

import { useEffect, useState } from 'react'
import { AudioLevelMeter } from '@/lib/voice-orb/audio-level'

/** Smallest change worth a re-render. The halo scales by 0.35 in total, so this
 *  is well under a pixel of movement. */
const EPSILON = 0.02

export function useAudioLevel(active: boolean, streams: () => MediaStream[]): number {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!active) {
      setLevel(0)
      return
    }
    const meter = new AudioLevelMeter()
    let frame = 0
    let last = 0
    const tick = () => {
      // Streams land after the handshake, so keep reconciling them.
      meter.attach(streams())
      const next = meter.level()
      if (Math.abs(next - last) >= EPSILON) {
        last = next
        setLevel(next)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      meter.close()
    }
  }, [active, streams])

  return level
}
