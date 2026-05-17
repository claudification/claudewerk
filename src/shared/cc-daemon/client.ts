/**
 * Control-socket client for the Claude Code background-session daemon.
 *
 * Framing: newline-delimited JSON. The daemon answers exactly one response then
 * closes the connection -- so `request()` opens a fresh connection per call.
 * Streaming ops (subscribe, attach) live in their own modules.
 *
 * Every frame is stamped with `proto` (see types.ts). A version mismatch on a
 * gated op returns `{ ok: false, code: 'EPROTO' }`, surfaced here as
 * ProtocolMismatchError so callers can tell the user to update claudewerk.
 *
 * Uses `node:net` (not `Bun.connect`) so this module type-checks under both the
 * Bun server tsconfig and the web tsconfig that compiles `src/shared/`.
 */
import { createConnection } from 'node:net'
import { CC_DAEMON_PROTO, type ControlRequest, type DaemonResponse } from './types'

/** Thrown when the daemon rejects a frame with EPROTO (CC bumped the protocol). */
export class ProtocolMismatchError extends Error {
  constructor(detail: string) {
    super(`Claude Code daemon protocol mismatch: ${detail}`)
    this.name = 'ProtocolMismatchError'
  }
}

/** Encode a request as a proto-stamped, newline-terminated JSON frame. */
export function encodeFrame(op: ControlRequest): string {
  return `${JSON.stringify({ proto: CC_DAEMON_PROTO, ...op })}\n`
}

/** Parse one JSON response line into a DaemonResponse. Throws on malformed input. */
export function parseResponse(line: string): DaemonResponse {
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    throw new Error(`cc-daemon: non-JSON response frame: ${truncate(line)}`)
  }
  if (!obj || typeof obj !== 'object' || typeof (obj as { ok?: unknown }).ok !== 'boolean') {
    throw new Error(`cc-daemon: malformed response frame: ${truncate(line)}`)
  }
  return obj as DaemonResponse
}

function truncate(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}

export interface RequestOptions {
  /** Milliseconds to wait for the response before giving up. Default 8000. */
  timeoutMs?: number
}

/**
 * Send one request to the control socket and resolve its response.
 * Opens a fresh connection (the daemon is one-response-per-connection).
 * Throws ProtocolMismatchError when the daemon reports EPROTO.
 */
export async function request(
  sockPath: string,
  op: ControlRequest,
  options: RequestOptions = {},
): Promise<DaemonResponse> {
  const line = await readOneFrame(sockPath, op, options.timeoutMs ?? 8000)
  const resp = parseResponse(line)
  if (resp.ok === false && resp.code === 'EPROTO') {
    throw new ProtocolMismatchError(resp.error)
  }
  return resp
}

/** Connect, send one frame, resolve the first newline-delimited line back. */
function readOneFrame(sockPath: string, op: ControlRequest, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: sockPath })

    let buf = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`cc-daemon: ${op.op} timed out after ${timeoutMs}ms`))),
      timeoutMs,
    )

    socket.on('connect', () => {
      socket.write(encodeFrame(op))
    })
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const nl = buf.indexOf('\n')
      if (nl >= 0) finish(() => resolve(buf.slice(0, nl)))
    })
    socket.on('close', () => {
      // No newline seen: tolerate a frame sent without a trailing newline.
      finish(() =>
        buf.length > 0 ? resolve(buf) : reject(new Error(`cc-daemon: ${op.op} connection closed with no response`)),
      )
    })
    socket.on('error', (err: Error) => {
      finish(() => reject(new Error(`cc-daemon: ${op.op} socket error: ${err.message}`)))
    })
  })
}
