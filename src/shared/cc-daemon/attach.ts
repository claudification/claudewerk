/**
 * `attach` -- the held duplex connection to a Claude Code daemon worker.
 *
 * This is the transport that lets claudewerk host a daemon worker as a
 * subscription-billed conversation in place of headless `--print`.
 *
 * Flow, live-verified against the 2.1.143 daemon:
 *   1. Connect `control.sock`, send the `attach` request as newline-JSON.
 *   2. The daemon answers one newline-JSON ack frame:
 *        {ok:true,op:"attach",decModes,via,tempo,state}
 *      (or {ok:false,...} -- ENOJOB / EPROTO / EUNVERIFIED / EKICKED / ...).
 *   3. On the SAME connection, the daemon then streams raw PTY bytes. Bytes
 *      written back are fed to the worker's PTY as input. This is a raw,
 *      unframed terminal duplex -- exactly the shape claudewerk's existing PTY
 *      backend already mirrors to the broker.
 *
 * `resize` is a separate request/response control op (`ops.resize`).
 *
 * The companion `ptySock` (see `socket-path.resolveWorkerPtySock`) carries the
 * SAME bytes under the 5-byte `frame.ts` framing plus a kind-1 control channel;
 * `attach.ts` uses the simpler raw control-socket duplex. `frame.ts` stays the
 * home for any framed-`ptySock` consumer.
 *
 * Uses `node:net` (not `Bun.connect`) so this module type-checks under both the
 * Bun server tsconfig and the web tsconfig that compiles `src/shared/`.
 */
import { createConnection, type Socket } from 'node:net'
import { encodeFrame, ProtocolMismatchError, parseJsonObject, truncate } from './client'
import { resize } from './ops'
import type { AttachAck, AttachCaps, DaemonErr, DaemonErrorCode } from './types'

/** Default attacher caps when the caller does not supply its own. */
const DEFAULT_CAPS: AttachCaps = { terminal: 'xterm-256color', mux: null, ssh: false }

/**
 * Thrown when the daemon refuses an `attach` with a structured `{ok:false}`
 * frame. Carries the daemon `code` (ENOJOB / ESTARTING / EKICKED / ...) so a
 * caller -- `attachWithRetry` in particular -- can branch on it cleanly rather
 * than regex-matching the message. `EPROTO` is NOT surfaced here: it becomes a
 * `ProtocolMismatchError` (never retried).
 */
export class DaemonAttachError extends Error {
  /** Daemon error code from the rejection frame, if the daemon supplied one. */
  readonly code: DaemonErrorCode | undefined
  constructor(message: string, code: DaemonErrorCode | undefined) {
    super(message)
    this.name = 'DaemonAttachError'
    this.code = code
  }
}

/** Why an attach session ended -- reported to `onClose`. */
export type AttachCloseReason =
  | 'client-closed' // .close() was called
  | 'socket-closed' // the daemon closed the connection
  | 'socket-error' // a transport error
  | 'connect-timeout' // the socket never connected

export interface AttachOptions {
  /** Initial terminal width, in columns. */
  cols: number
  /** Initial terminal height, in rows. */
  rows: number
  /** Raw PTY output bytes from the worker. */
  onData: (pty: Buffer) => void
  /** Fired once when the session ends, for any reason. */
  onClose?: (reason: AttachCloseReason) => void
  /** Fired on a transport error, just before `onClose`. */
  onError?: (err: Error) => void
  /** Attacher capabilities. Defaults to a plain xterm-256color terminal. */
  caps?: AttachCaps
  /** Ask the daemon to replay a holding frame of the current screen. Default true. */
  holdingFrame?: boolean
  /** Stable per-attacher id (so `resize` can target this attacher). Auto-generated if omitted. */
  attachId?: string
  /** Milliseconds to wait for the socket to connect + ack. Default 8000. */
  connectTimeoutMs?: number
}

/** A live attach session. */
export interface AttachHandle {
  /** The daemon's attach ack -- `decModes`, `state`, `tempo` at attach time. */
  readonly ack: AttachAck
  /** The attacher id used for this session (echo for `resize` targeting). */
  readonly attachId: string
  /** Feed raw bytes to the worker's PTY as input. */
  writeInput(data: Buffer | string): void
  /** Resize the worker PTY for this attacher. */
  resize(cols: number, rows: number): Promise<void>
  /** Detach: close the held connection. Idempotent. */
  close(): void
  /** True once the session has ended. */
  readonly closed: boolean
}

/** Generate a per-attach id. */
function makeAttachId(): string {
  return `att_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Build an Error from a daemon rejection frame. `EPROTO` becomes a
 * `ProtocolMismatchError` (never retried); every other code becomes a
 * `DaemonAttachError` carrying the `code` so the retry layer can branch on it.
 */
function rejectionError(frame: DaemonErr, short: string): Error {
  if (frame.code === 'EPROTO') return new ProtocolMismatchError(frame.error)
  const suffix = frame.code ? ` (${frame.code})` : ''
  return new DaemonAttachError(`cc-daemon: attach ${short} rejected: ${frame.error}${suffix}`, frame.code)
}

/** Internal mutable state shared by the connection's event handlers. */
interface AttachState {
  ackSeen: boolean
  /** Buffered bytes before the newline that terminates the ack frame. */
  ackBuf: Buffer
  closed: boolean
}

/**
 * Open a held attach connection to daemon worker `short`.
 *
 * Resolves once the daemon has acked the attach (the handle carries `ack`);
 * rejects if the daemon refuses (ENOJOB, EKICKED, EPROTO, ...) or the socket
 * fails before the ack. After resolution, raw PTY bytes arrive via `onData`.
 */
export function attach(controlSockPath: string, short: string, opts: AttachOptions): Promise<AttachHandle> {
  const attachId = opts.attachId ?? makeAttachId()
  const connectTimeoutMs = opts.connectTimeoutMs ?? 8000
  const holdingFrame = opts.holdingFrame ?? true

  return new Promise<AttachHandle>((resolve, reject) => {
    const socket: Socket = createConnection({ path: controlSockPath })
    const state: AttachState = { ackSeen: false, ackBuf: Buffer.alloc(0), closed: false }

    const finish = (reason: AttachCloseReason, err?: Error): void => {
      if (state.closed) return
      state.closed = true
      clearTimeout(timer)
      socket.destroy()
      if (err) opts.onError?.(err)
      opts.onClose?.(reason)
      // A failure before the ack rejects the attach() promise.
      if (!state.ackSeen) reject(err ?? new Error(`cc-daemon: attach ${short} closed before ack`))
    }

    const timer = setTimeout(
      () => finish('connect-timeout', new Error(`cc-daemon: attach ${short} timed out after ${connectTimeoutMs}ms`)),
      connectTimeoutMs,
    )

    socket.on('connect', () => {
      socket.write(
        encodeFrame({
          op: 'attach',
          short,
          cols: opts.cols,
          rows: opts.rows,
          attachId,
          caps: { ...DEFAULT_CAPS, ...opts.caps },
          holdingFrame,
        }),
      )
    })

    /** Consume the newline-JSON ack, then resolve the handle. */
    const handleAck = (line: string, rest: Buffer): void => {
      const obj = parseJsonObject(line, 'attach ack')
      if (obj.ok === false) {
        finish('socket-error', rejectionError(obj as unknown as DaemonErr, short))
        return
      }
      state.ackSeen = true
      clearTimeout(timer)
      const ack = obj as unknown as AttachAck
      resolve(buildHandle(socket, controlSockPath, short, attachId, ack, state, finish))
      // Any bytes after the ack newline are the first raw PTY output.
      if (rest.length > 0) opts.onData(rest)
    }

    socket.on('data', (chunk: Buffer) => {
      if (state.ackSeen) {
        opts.onData(chunk)
        return
      }
      state.ackBuf = state.ackBuf.length === 0 ? chunk : Buffer.concat([state.ackBuf, chunk])
      const nl = state.ackBuf.indexOf(0x0a)
      if (nl < 0) {
        if (state.ackBuf.length > 64 * 1024) {
          finish(
            'socket-error',
            new Error(`cc-daemon: attach ${short} ack frame absurdly long: ${truncate(state.ackBuf.toString())}`),
          )
        }
        return // ack frame not yet complete
      }
      handleAck(state.ackBuf.subarray(0, nl).toString('utf8'), state.ackBuf.subarray(nl + 1))
    })

    socket.on('close', () => finish('socket-closed'))
    socket.on('error', (err: Error) =>
      finish('socket-error', new Error(`cc-daemon: attach ${short} socket error: ${err.message}`)),
    )
  })
}

/** Build the public handle once the attach is acked. */
function buildHandle(
  socket: Socket,
  controlSockPath: string,
  short: string,
  attachId: string,
  ack: AttachAck,
  state: AttachState,
  finish: (reason: AttachCloseReason, err?: Error) => void,
): AttachHandle {
  return {
    ack,
    attachId,
    writeInput(data: Buffer | string): void {
      if (state.closed) return
      socket.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    },
    async resize(cols: number, rows: number): Promise<void> {
      const resp = await resize(controlSockPath, short, cols, rows, attachId)
      if (resp.ok === false) throw new Error(`cc-daemon: resize ${short} failed: ${resp.error}`)
    },
    close(): void {
      finish('client-closed')
    },
    get closed(): boolean {
      return state.closed
    },
  }
}
