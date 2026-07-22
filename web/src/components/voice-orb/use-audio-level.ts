/**
 * Drive the orb's halo off live audio: one rAF loop, one state update per frame,
 * only while the orb is actually up. Idle orbs cost nothing.
 */

import { useEffect, useState } from 'react'
import { AudioLevelMeter } from '@/lib/voice-orb/audio-level'

export function useAudioLevel(active: boolean, streams: () => MediaStream[]): number {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!active) {
      setLevel(0)
      return
    }
    const meter = new AudioLevelMeter()
    let frame = 0
    const tick = () => {
      // Streams land after the handshake, so keep offering them to the meter.
      meter.attach(streams())
      setLevel(meter.level())
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
