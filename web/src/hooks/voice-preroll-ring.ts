/**
 * voice-preroll-ring - the fixed window of speech kept from before the press.
 *
 * Split out of voice-preroll so that file is only about the GRAPH's lifecycle
 * (build it once, bind it to a stream, never build a second) and this one is only
 * about what is retained. They fail differently and are read for different
 * reasons: a lifecycle bug silences the microphone, a retention bug sends the
 * wrong seconds of audio.
 *
 * NOTHING HERE LEAVES THE BROWSER on its own. The ring is handed over only when a
 * press arms it, and dropped whenever the recording ends or the mic is released.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { peakDbfs } from '@/hooks/voice-capture-pcm'

export interface RingFrame {
  buf: ArrayBuffer
  ms: number
}

/** What the ring gave back, and whether there was anything in it. */
export interface PrerollDrain {
  frames: RingFrame[]
  ms: number
  peakDb: number
}

const ring: RingFrame[] = []
let ringMs = 0

function capMs(): number {
  return useConversationsStore.getState().controlPanelPrefs.voicePrerollMs ?? 0
}

export function clearRing() {
  ring.length = 0
  ringMs = 0
}

/** Keep the newest `cap` milliseconds, evicting whole frames from the front. */
export function pushRing(buf: ArrayBuffer, ms: number) {
  const cap = capMs()
  if (cap <= 0) {
    if (ring.length) clearRing()
    return
  }
  ring.push({ buf, ms })
  ringMs += ms
  // Evict whole frames while the ring would STILL hold `cap` ms without the
  // oldest one, so the window is always at least `cap` and never a frame short.
  while (ring.length > 1) {
    const oldest = ring[0]
    if (!oldest || ringMs - oldest.ms < cap) break
    ring.shift()
    ringMs -= oldest.ms
  }
}

/**
 * Take everything retained and empty the ring. Reports the peak level too,
 * because "1400ms recovered" and "1400ms of speech recovered" are different
 * claims and only the second one answers whether words were being lost.
 */
export function drainRing(): PrerollDrain {
  const frames = ring.slice()
  clearRing()
  return {
    frames,
    ms: Math.round(frames.reduce((sum, f) => sum + f.ms, 0)),
    peakDb: peakDbfs(frames.map(f => f.buf)),
  }
}
