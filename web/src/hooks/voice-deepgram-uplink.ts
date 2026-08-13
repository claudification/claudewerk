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
 * Raw PCM has no header, but it has no framing either: a hole is silently
 * mis-decoded rather than rejected, which is worse.
 *
 * WHAT IT CAPTURES WITH IS THE MODEL'S CALL, not this file's -- see
 * voice-capture-engine. The container engine exists synchronously, so capture is
 * running before this function returns; the PCM engine has to load its worklet
 * module first, so there is a short async gap that nothing can remove. Every
 * ordering guarantee below holds across both.
 */

import {
  type AudioChunk,
  type CaptureEngine,
  type CaptureKind,
  chunkBytes,
  startCapture,
} from '@/hooks/voice-capture-engine'
import type { FlushStats } from '@/hooks/voice-deepgram-protocol'

/**
 * Hard bound on pre-open buffering. ~4MB is minutes of opus -- far past any
 * healthy connect (which is well under a second). Blowing it means the socket
 * is not coming up, and we surface that instead of holding audio forever.
 */
const MAX_BUFFERED_BYTES = 4_000_000

export interface UplinkCallbacks {
  /** Buffered past the bound -- the socket is never coming up. Fatal. */
  onOverflow(bufferedBytes: number): void
  /** The capture engine never came up (worklet module failed to load, no mic
   *  permission left by the time it started). Fatal: there is no audio at all. */
  onCaptureError(err: unknown): void
  /**
   * Every capture delivery, for the lag meter: a gap here means the ENCODER
   * starved us, while a non-zero `buffered` means the SOCKET is the bottleneck.
   * Observation only -- it must not affect what gets sent.
   */
  onDelivery?(size: number, buffered: number, label: string): void
}

export interface Uplink {
  /** Hand over the OPEN socket: flush every buffered chunk in order, then stream live. */
  attach(ws: WebSocket): FlushStats
  /**
   * Stop capturing. Resolves only once the engine's FINAL chunk has been
   * delivered (MediaRecorder fires it asynchronously, then `stop`; the worklet
   * posts its sub-frame remainder, then an ack), so the caller can flush the
   * Worker knowing the last chunk is already on the wire or in the buffer.
   * Awaiting this is what keeps the tail of an utterance -- up to a full second
   * of speech on Safari, whose muxer emits ~1s fragments.
   */
  stopRecorder(): Promise<void>
  /** Tear down and drop anything still buffered. Idempotent. */
  dispose(): void
}

export function startUplink(stream: MediaStream, kind: CaptureKind, callbacks: UplinkCallbacks): Uplink {
  const pending: AudioChunk[] = []
  let pendingBytes = 0
  let socket: WebSocket | null = null
  let disposed = false
  let overflowed = false

  function deliver(data: AudioChunk, label: string) {
    const size = chunkBytes(data)
    callbacks.onDelivery?.(size, socket?.bufferedAmount ?? 0, label)
    if (disposed || size === 0) return
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data)
      return
    }
    buffer(data, size)
  }

  // Started BEFORE anything below can await: for `container` the recorder is
  // already running when this line returns, and `engine` is set synchronously so
  // a release in the same tick still stops the real recorder.
  const started = startCapture(stream, kind, deliver)
  let engine: CaptureEngine | null = started instanceof Promise ? null : started
  const ready: Promise<void> =
    started instanceof Promise
      ? started.then(
          e => {
            if (disposed) return e.dispose()
            engine = e
          },
          err => {
            console.error('[voice] capture engine failed to start --', err)
            callbacks.onCaptureError(err)
          },
        )
      : Promise.resolve()

  function buffer(chunk: AudioChunk, size: number) {
    if (overflowed) return
    pending.push(chunk)
    pendingBytes += size
    if (pendingBytes <= MAX_BUFFERED_BYTES) return
    // Dropping to make room would punch a hole in the audio -- the decoder would
    // read garbage or nothing. Fail loudly instead.
    overflowed = true
    console.error(`[voice] uplink buffer overflow at ${pendingBytes}B -- socket never opened`)
    callbacks.onOverflow(pendingBytes)
  }

  function attach(ws: WebSocket): FlushStats {
    socket = ws
    const stats: FlushStats = { chunks: pending.length, bytes: pendingBytes }
    for (const chunk of pending) ws.send(chunk)
    pending.length = 0
    pendingBytes = 0
    return stats
  }

  async function stopRecorder(): Promise<void> {
    // Released before the worklet finished loading: wait for it, then stop it,
    // rather than leaving a live engine streaming into a closed session.
    if (!engine) await ready
    await engine?.stop()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    engine?.dispose()
    pending.length = 0
    pendingBytes = 0
    socket = null
  }

  return { attach, stopRecorder, dispose }
}
