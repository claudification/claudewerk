/**
 * voice-preroll - hold the last N ms of the warm mic in memory, so pressing the
 * key chooses where the recording BEGAN rather than merely when it started.
 *
 * WHY THIS EXISTS. Four separate costs sit between the key going down and the
 * first sample being captured, and every one of them eats speech:
 *
 *   1. the chord grace window (70ms, push-to-talk-guard) -- a deliberate wait to
 *      see whether this hold is really the first half of a chord;
 *   2. a cold getUserMedia (300-3000ms) once the warm stream TTL has lapsed;
 *   3. building an AudioContext + loading the worklet module, which used to
 *      happen per press (50-300ms) and now happens once per warm stream;
 *   4. the plain fact that a person starts the first syllable as the key bottoms
 *      out, not after it.
 *
 * Everything downstream of startUplink already buffers correctly -- that was the
 * 2026-07-23 fix -- but buffering can only save audio that was CAPTURED, and none
 * of the above is. The ring is the only place those words can come from: they
 * have to have been recorded before the press. `voiceLingerMs` has kept the TAIL
 * of every utterance since the beginning; this is the head.
 *
 * WHAT IT COSTS AND DOES NOT DO. The mic has to already be open, so a genuinely
 * cold press gets nothing -- there was no audio to have kept. The ring is a fixed
 * window in memory, never leaves the browser until a press arms it, and is
 * dropped on release so one dictation cannot leak its tail into the head of the
 * next.
 *
 * PCM ONLY, and not by preference. A container stream cannot be spliced: chunk 0
 * carries the webm EBML / mp4 init segment and the muxer's timeline is
 * continuous, so there is no point in the middle you can begin sending from.
 * Raw linear16 has no header and no framing, so any frame boundary is a legal
 * place to start -- which is exactly what a ring needs.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import type { CaptureEngine, ChunkHandler } from '@/hooks/voice-capture-contract'
import { PCM_LABEL, type PcmGraph, startPcmGraph } from '@/hooks/voice-capture-pcm'

interface RingFrame {
  buf: ArrayBuffer
  ms: number
}

let graph: PcmGraph | null = null
/** In-flight build, so a press landing during the warm-up joins it rather than
 *  starting a second AudioContext on the same device. */
let building: Promise<PcmGraph> | null = null
let boundStream: MediaStream | null = null
const ring: RingFrame[] = []
let ringMs = 0
/** Set only while a recording is armed. Null means the ring is listening. */
let liveHandler: ChunkHandler | null = null

function prerollCapMs(): number {
  return useConversationsStore.getState().controlPanelPrefs.voicePrerollMs ?? 0
}

function clearRing() {
  ring.length = 0
  ringMs = 0
}

/** Keep the newest `cap` milliseconds, evicting whole frames from the front. */
function pushRing(buf: ArrayBuffer, ms: number) {
  const cap = prerollCapMs()
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

function routeFrame(buf: ArrayBuffer, ms: number) {
  if (liveHandler) liveHandler(buf, PCM_LABEL)
  else pushRing(buf, ms)
}

async function buildGraph(stream: MediaStream): Promise<PcmGraph> {
  const built = await startPcmGraph(stream)
  built.onFrame = routeFrame
  graph = built
  boundStream = stream
  building = null
  return built
}

/** Drop the graph and everything it captured. The warm stream owns this. */
export function disposePreroll() {
  graph?.dispose()
  graph = null
  building = null
  boundStream = null
  liveHandler = null
  clearRing()
}

/**
 * Start capturing into the ring for this stream (fire-and-forget). Called when a
 * warm mic stream is acquired -- from then on the ring always holds the last
 * `voicePrerollMs` of audio, ready for a press that has not happened yet.
 */
export function startPreroll(stream: MediaStream) {
  if (boundStream !== stream) disposePreroll()
  if (graph || building) return
  const pending = buildGraph(stream)
  building = pending
  // Handled HERE so a failed warm-up is not an unhandled rejection. A press that
  // joins this same promise gets the rejection too, and surfaces it honestly.
  pending.catch(err => {
    building = null
    console.warn('[voice] preroll graph failed to start --', err)
  })
}

/** Hand the ring over, oldest frame first, then go live. */
function armGraph(g: PcmGraph, onChunk: ChunkHandler): CaptureEngine {
  const frames = ring.slice()
  clearRing()
  // Live BEFORE the drain: the drain itself is synchronous, but going live first
  // means there is no instant at which a frame could land in a ring that has
  // already been read and will never be read again.
  liveHandler = onChunk
  for (const frame of frames) onChunk(frame.buf, PCM_LABEL)
  const rolled = frames.reduce((sum, f) => sum + f.ms, 0)
  console.log(`[voice] preroll armed: ${frames.length} frames / ${Math.round(rolled)}ms of speech before the press`)

  /** Every settle path drops the live handler, the flush timeout included: audio
   *  captured after the key came up is speech the user did not mean to send. */
  function disarm() {
    liveHandler = null
    clearRing()
  }

  return {
    label: PCM_LABEL,
    stop: () => g.flush().then(disarm),
    dispose: disarm,
  }
}

/**
 * Begin a recording off the persistent graph. Synchronous -- and therefore free
 * -- whenever the mic is warm and the graph is already running, which is the
 * whole point: the press must not pay for setup. Falls back to building the
 * graph (async, and with an empty ring) when there was nothing warm to reuse.
 */
export function armPreroll(stream: MediaStream, onChunk: ChunkHandler): CaptureEngine | Promise<CaptureEngine> {
  if (graph && boundStream === stream && graph.isRunning()) return armGraph(graph, onChunk)
  if (boundStream !== stream) disposePreroll()
  const pending = building ?? buildGraph(stream)
  building = pending
  return pending.then(async g => {
    // A context the platform suspended has an empty and stale ring; resuming is
    // still worth it, because the recording that follows needs a live graph.
    await g.resume()
    return armGraph(g, onChunk)
  })
}
