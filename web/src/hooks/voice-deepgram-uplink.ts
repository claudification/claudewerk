/**
 * voice-deepgram-uplink - capture the mic IMMEDIATELY, buffer until the socket
 * is up, then flush in order and go live.
 *
 * WHY THIS EXISTS: the recorder used to be constructed inside `ws.onopen`, so
 * everything said between pressing the key and the Deepgram socket opening (token
 * mint + WS dial + TLS -- easily 1-2s) was never captured at all. The mic looked
 * live, the UI said "recording", and the words simply did not exist. Recording
 * starts the instant the mic stream is in hand; the socket catches up.
 *
 * ORDER IS LOAD-BEARING: chunk 0 carries the container header (webm EBML /
 * mp4 init segment). Deepgram cannot decode the stream without it, and cannot
 * decode a stream with a hole in it -- so the buffer is flushed whole, in order,
 * or the attempt fails honestly. It is never partially dropped to make room.
 */

import type { FlushStats } from '@/hooks/voice-deepgram-protocol'

/** MediaRecorder timeslice. Safari's mp4 muxer ignores this and emits ~1s
 *  fragments regardless (a WebKit law, see project_voice_pcm_worklet_lag_fix). */
const CHUNK_MS = 100

/**
 * Hard bound on pre-open buffering. ~4MB is minutes of opus -- far past any
 * healthy connect (which is well under a second). Blowing it means the socket
 * is not coming up, and we surface that instead of holding audio forever.
 */
const MAX_BUFFERED_BYTES = 4_000_000

/** If the `stop` event never lands, don't hang the release forever. */
const RECORDER_STOP_TIMEOUT_MS = 500

export interface UplinkCallbacks {
  /** Buffered past the bound -- the socket is never coming up. Fatal. */
  onOverflow(bufferedBytes: number): void
}

export interface Uplink {
  /** Hand over the OPEN socket: flush every buffered chunk in order, then stream live. */
  attach(ws: WebSocket): FlushStats
  /**
   * Stop capturing. Resolves only once the recorder's FINAL `dataavailable` has
   * been delivered (MediaRecorder fires it asynchronously, then `stop`), so the
   * caller can flush Deepgram knowing the last chunk is already on the wire or
   * in the buffer. Awaiting this is what keeps the tail of an utterance -- up to
   * a full second of speech on Safari, whose muxer emits ~1s fragments.
   */
  stopRecorder(): Promise<void>
  /** Tear down and drop anything still buffered. Idempotent. */
  dispose(): void
}

/** webm/opus everywhere it exists; Safari has no opus in MediaRecorder -> mp4/AAC. */
function pickMimeType(): string {
  return MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'
}

export function startUplink(stream: MediaStream, callbacks: UplinkCallbacks): Uplink {
  const pending: Blob[] = []
  let pendingBytes = 0
  let socket: WebSocket | null = null
  let disposed = false
  let overflowed = false

  const recorder = new MediaRecorder(stream, { mimeType: pickMimeType() })
  recorder.ondataavailable = ev => {
    if (disposed || ev.data.size === 0) return
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(ev.data)
      return
    }
    buffer(ev.data)
  }
  recorder.start(CHUNK_MS)

  function buffer(blob: Blob) {
    if (overflowed) return
    pending.push(blob)
    pendingBytes += blob.size
    if (pendingBytes <= MAX_BUFFERED_BYTES) return
    // Dropping to make room would punch a hole in the container -- Deepgram
    // would decode garbage or nothing. Fail loudly instead.
    overflowed = true
    console.error(`[voice] uplink buffer overflow at ${pendingBytes}B -- socket never opened`)
    callbacks.onOverflow(pendingBytes)
  }

  function attach(ws: WebSocket): FlushStats {
    socket = ws
    const stats: FlushStats = { chunks: pending.length, bytes: pendingBytes }
    for (const blob of pending) ws.send(blob)
    pending.length = 0
    pendingBytes = 0
    return stats
  }

  function stopRecorder(): Promise<void> {
    if (recorder.state === 'inactive') return Promise.resolve()
    return new Promise<void>(resolve => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      recorder.onstop = done
      setTimeout(done, RECORDER_STOP_TIMEOUT_MS)
      try {
        recorder.stop()
      } catch {
        done()
      }
    })
  }

  function dispose() {
    if (disposed) return
    disposed = true
    void stopRecorder()
    pending.length = 0
    pendingBytes = 0
    socket = null
  }

  return { attach, stopRecorder, dispose }
}
