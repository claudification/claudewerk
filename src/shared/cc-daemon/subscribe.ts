/**
 * Streaming `subscribe` op for the Claude Code daemon control socket.
 *
 * Unlike the request/response ops in client.ts, `subscribe` HOLDS the
 * connection open: the daemon answers with a `snapshot` frame, then pushes
 * incremental delta frames until the connection closes. Framing is the same
 * newline-delimited JSON -- just many frames instead of one.
 *
 * Monitoring-grade. The snapshot's `record` is compact job state and
 * `streamTail` is raw PTY/ANSI scrollback; for live interaction use `attach`.
 *
 * Uses `node:net` (not `Bun.connect`) so this module type-checks under both
 * the Bun server tsconfig and the web tsconfig that compiles `src/shared/`.
 */
import { createConnection } from 'node:net'
import { encodeFrame, ProtocolMismatchError, parseJsonObject, truncate } from './client'
import type { DaemonErr, JobRecord } from './types'

/** The first frame `subscribe` emits: a full snapshot of the job. */
export interface SubscribeSnapshot {
  type: 'snapshot'
  /** Compact job state -- same shape `list` returns inline. */
  record: JobRecord
  /** Raw PTY/ANSI scrollback byte-strings (the terminal tail). */
  streamTail?: string[]
}

/**
 * An incremental frame after the snapshot. Shapes past `type` are not yet
 * live-verified, so this stays permissive on purpose -- callers branch on
 * `type` and read fields defensively.
 */
export interface SubscribeDelta {
  type: string
  [field: string]: unknown
}

export type DaemonSubscribeFrame = SubscribeSnapshot | SubscribeDelta

/** True when a parsed frame is a daemon error response, not a stream frame. */
export function isErrorFrame(frame: DaemonSubscribeFrame | DaemonErr): frame is DaemonErr {
  return (frame as DaemonErr).ok === false
}

/**
 * True when a stream frame is the initial snapshot. A type guard, because the
 * permissive `SubscribeDelta` index signature blocks plain `type ===` narrowing.
 */
export function isSnapshot(frame: DaemonSubscribeFrame): frame is SubscribeSnapshot {
  return frame.type === 'snapshot'
}

/**
 * Parse one newline-delimited JSON frame from a `subscribe` stream.
 *
 * The daemon can answer a subscribe with an error response (e.g. ENOJOB,
 * EPROTO) in place of a snapshot, so the return type admits `DaemonErr`;
 * callers discriminate with `isErrorFrame`. Throws on malformed input.
 */
/** Throw if a `snapshot` frame is missing its `record` object. */
function assertSnapshotShape(obj: Record<string, unknown>, line: string): void {
  if (obj.type === 'snapshot' && (!obj.record || typeof obj.record !== 'object')) {
    throw new Error(`cc-daemon: subscribe snapshot missing \`record\`: ${truncate(line)}`)
  }
}

export function parseSubscribeFrame(line: string): DaemonSubscribeFrame | DaemonErr {
  const obj = parseJsonObject(line, 'subscribe frame')
  if (obj.ok === false) return obj as unknown as DaemonErr
  if (typeof obj.type !== 'string') {
    throw new Error(`cc-daemon: subscribe frame missing string \`type\`: ${truncate(line)}`)
  }
  assertSnapshotShape(obj, line)
  return obj as unknown as DaemonSubscribeFrame
}

/**
 * Split a buffer into complete newline-terminated lines plus the trailing
 * partial. Pure -- the streaming loop carries `rest` forward across chunks so
 * a frame split across two TCP reads still reassembles. Empty lines (a bare
 * `\n` between frames) are dropped.
 */
export function splitFrames(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts.filter(line => line.length > 0), rest }
}

/** No-op default for optional callbacks, so `finish` never branches on `?.`. */
const noop = (): void => {}

/** Build an Error from a daemon error frame -- ProtocolMismatchError on EPROTO. */
function errorFromFrame(frame: DaemonErr, short: string): Error {
  if (frame.code === 'EPROTO') return new ProtocolMismatchError(frame.error)
  const suffix = frame.code ? ` (${frame.code})` : ''
  return new Error(`cc-daemon: subscribe ${short} rejected: ${frame.error}${suffix}`)
}

/** Why a subscription ended -- reported to `onClose`. */
export type SubscribeCloseReason =
  | 'client-closed' // .close() was called
  | 'socket-closed' // the daemon closed the connection
  | 'socket-error' // a transport error
  | 'daemon-error' // the daemon answered with an error frame
  | 'parse-error' // a frame failed to parse
  | 'connect-timeout' // the socket never connected

export interface SubscribeCallbacks {
  /** Fired for each frame: the snapshot first, then incremental deltas. */
  onEvent: (frame: DaemonSubscribeFrame) => void
  /** Fired once when the stream ends, for any reason. */
  onClose?: (reason: SubscribeCloseReason) => void
  /** Fired on a transport or protocol error, just before `onClose`. */
  onError?: (err: Error) => void
}

export interface SubscribeOptions {
  /** Milliseconds to wait for the socket to connect. Default 8000. */
  connectTimeoutMs?: number
}

export interface SubscribeHandle {
  /** Close the held connection and stop emitting. Idempotent. */
  close(): void
  /** True once the stream has ended (by the daemon, an error, or `close()`). */
  readonly closed: boolean
}

/**
 * Open a held `subscribe` connection for one job and stream its frames.
 *
 * Returns immediately with a handle; frames arrive asynchronously via
 * `callbacks.onEvent`. The daemon is transient, so a missing socket simply
 * surfaces as a `socket-error` close -- not an exception.
 */
export function subscribe(
  sockPath: string,
  short: string,
  callbacks: SubscribeCallbacks,
  options: SubscribeOptions = {},
): SubscribeHandle {
  const connectTimeoutMs = options.connectTimeoutMs ?? 8000
  const socket = createConnection({ path: sockPath })
  const onError = callbacks.onError ?? noop
  const onClose = callbacks.onClose ?? noop

  let closed = false
  let rest = ''
  let connectTimer: ReturnType<typeof setTimeout> | undefined

  const finish = (reason: SubscribeCloseReason, err?: Error): void => {
    if (closed) return
    closed = true
    if (connectTimer) clearTimeout(connectTimer)
    socket.destroy()
    if (err) onError(err)
    onClose(reason)
  }

  connectTimer = setTimeout(
    () =>
      finish(
        'connect-timeout',
        new Error(`cc-daemon: subscribe ${short} connect timed out after ${connectTimeoutMs}ms`),
      ),
    connectTimeoutMs,
  )

  socket.on('connect', () => {
    if (connectTimer) {
      clearTimeout(connectTimer)
      connectTimer = undefined
    }
    socket.write(encodeFrame({ op: 'subscribe', short }))
  })

  // Parse and dispatch one frame; calls `finish` on a bad or error frame.
  const processLine = (line: string): void => {
    let frame: DaemonSubscribeFrame | DaemonErr
    try {
      frame = parseSubscribeFrame(line)
    } catch (err) {
      finish('parse-error', err as Error)
      return
    }
    if (isErrorFrame(frame)) {
      finish('daemon-error', errorFromFrame(frame, short))
      return
    }
    callbacks.onEvent(frame)
  }

  socket.on('data', (chunk: Buffer) => {
    if (closed) return
    const split = splitFrames(rest + chunk.toString())
    rest = split.rest
    for (const line of split.lines) {
      processLine(line)
      if (closed) return // a bad frame or an onEvent-triggered close() ends the stream
    }
  })

  socket.on('close', () => finish('socket-closed'))
  socket.on('error', (err: Error) =>
    finish('socket-error', new Error(`cc-daemon: subscribe ${short} socket error: ${err.message}`)),
  )

  return {
    close: () => finish('client-closed'),
    get closed() {
      return closed
    },
  }
}
