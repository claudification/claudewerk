/**
 * 5-byte binary framing for the Claude Code daemon PTY socket.
 *
 * Layout, live-verified against the 2.1.143 daemon's worker `ptySock`:
 *
 *   [len:u32be][kind:u8][payload]
 *
 *   - bytes 0..3  payload length, big-endian uint32
 *   - byte  4     frame kind: 0 = raw PTY bytes, 1 = control JSON
 *   - bytes 5..   payload (`len` bytes)
 *
 * kind-0 frames carry raw terminal bytes in both directions (worker output /
 * attacher input). kind-1 frames carry a control JSON object, tagged by a `t`
 * field -- observed: `{"t":"hello",...}` on connect, `{"t":"live"}` once the
 * worker is streaming.
 *
 * The framing is symmetric: the daemon encodes frames to the attacher and
 * decodes frames from it with this same codec.
 *
 * This module is pure (no I/O) so the codec is unit-testable on its own and
 * type-checks under both the Bun server tsconfig and the web tsconfig.
 */

/** Frame kinds. */
export const FRAME_KIND_PTY = 0
export const FRAME_KIND_CONTROL = 1

/** Header is a fixed 5 bytes: u32be length + u8 kind. */
const FRAME_HEADER_BYTES = 5

/** Max payload the daemon accepts on a single frame (1 MiB). */
export const MAX_FRAME_PAYLOAD_BYTES = 1024 * 1024

/** One decoded PTY-socket frame. */
export interface DaemonPtyFrame {
  /** `FRAME_KIND_PTY` (0) or `FRAME_KIND_CONTROL` (1). */
  kind: number
  /** Raw payload bytes -- terminal bytes (kind 0) or JSON (kind 1). */
  payload: Buffer
}

/** A kind-1 control frame's JSON body. Tagged by `t`; other fields vary. */
export interface DaemonControlMessage {
  t: string
  [field: string]: unknown
}

/** Encode one frame: `[len:u32be][kind:u8][payload]`. */
export function encodePtyFrame(kind: number, payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error(`cc-daemon: frame payload ${payload.length}B exceeds ${MAX_FRAME_PAYLOAD_BYTES}B`)
  }
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES)
  header.writeUInt32BE(payload.length, 0)
  header.writeUInt8(kind, 4)
  return Buffer.concat([header, payload])
}

/** Encode raw terminal input as a kind-0 PTY frame. */
export function encodePtyInput(data: Buffer | string): Buffer {
  return encodePtyFrame(FRAME_KIND_PTY, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
}

/** Encode a control object as a kind-1 frame. */
export function encodeControlFrame(message: DaemonControlMessage): Buffer {
  return encodePtyFrame(FRAME_KIND_CONTROL, Buffer.from(JSON.stringify(message), 'utf8'))
}

/**
 * Parse a kind-1 frame's payload into a control message. Throws (labelled) on
 * non-JSON, non-object, or a missing string `t` tag.
 */
export function parseControlMessage(payload: Buffer): DaemonControlMessage {
  let obj: unknown
  try {
    obj = JSON.parse(payload.toString('utf8'))
  } catch {
    throw new Error('cc-daemon: control frame payload is not JSON')
  }
  if (!obj || typeof obj !== 'object' || typeof (obj as { t?: unknown }).t !== 'string') {
    throw new Error('cc-daemon: control frame missing string `t` tag')
  }
  return obj as DaemonControlMessage
}

/**
 * Stateful, incremental frame decoder. Feed it socket chunks; it returns every
 * frame that has fully arrived, carrying any partial frame forward internally
 * so a frame split across TCP reads still reassembles.
 *
 * Guards `len` against `MAX_FRAME_PAYLOAD_BYTES`: a corrupt header (e.g. after
 * a protocol drift) throws here rather than triggering a huge allocation.
 */
export function makePtyFrameDecoder(): (chunk: Buffer) => DaemonPtyFrame[] {
  let buf: Buffer = Buffer.alloc(0)
  return (chunk: Buffer): DaemonPtyFrame[] => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
    const frames: DaemonPtyFrame[] = []
    while (buf.length >= FRAME_HEADER_BYTES) {
      const len = buf.readUInt32BE(0)
      if (len > MAX_FRAME_PAYLOAD_BYTES) {
        throw new Error(`cc-daemon: framed length ${len}B exceeds ${MAX_FRAME_PAYLOAD_BYTES}B -- corrupt stream`)
      }
      const kind = buf.readUInt8(4)
      const end = FRAME_HEADER_BYTES + len
      if (buf.length < end) break // partial frame -- wait for more bytes
      frames.push({ kind, payload: buf.subarray(FRAME_HEADER_BYTES, end) })
      buf = buf.subarray(end)
    }
    return frames
  }
}
