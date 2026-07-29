/**
 * launch-smoke-mirror -- the live orchestration layer of the cc-daemon launch
 * smoke harness (plan-daemon-launch-ux.md Phase H).
 *
 * `mirrorWorker()` is the exact attach + mirror sequence the daemon-agent-host
 * runs in production, lifted out of `index.ts` (an entrypoint that cannot be
 * imported as a library) so the harness can drive it for all three launch
 * modes. It dogfoods `cc-daemon` (`attach`), `attach-retry`, `session-observer`
 * and `transcript-bridge` against a real daemon.
 *
 * `runAttachStep()` and `fetchJobState()` are the seams the unit smoke
 * (`launch-smoke.test.ts`) drives against `fake-daemon.ts` -- no live daemon.
 */

import { randomBytes } from 'node:crypto'
import { buildDispatchSpec } from '../sentinel/daemon-dispatch'
import type { AttachCloseReason, AttachHandle, attach } from '../shared/cc-daemon/attach'
import { dispatch, list } from '../shared/cc-daemon/ops'
import { resolveControlSocket } from '../shared/cc-daemon/socket-path'
import type { ListResponse } from '../shared/cc-daemon/types'
import { attachWithRetry } from './attach-retry'
import type { DaemonMode } from './cli-args'
import type { InMemoryBroker, SmokeLogger } from './launch-smoke'
import { type DaemonSessionObserver, observeDaemonSession } from './session-observer'
import { createTranscriptBridge, type TranscriptBridge } from './transcript-bridge'

/** Default attach PTY size -- the worker is readable; no viewer resizes us. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

// ---------------------------------------------------------------------------
// dispatchDaemonWorker -- dispatch a worker via the cc-daemon socket op.
// The single canonical dispatch path: the smoke harness and the staging
// daemon-e2e test both call this. Transport-reframe Phase 4 -- it dogfoods the
// exact `buildDispatchSpec` + `dispatch()` socket path the sentinel runs in
// production (replacing the legacy `claude --bg` shell-out).
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  /** Worker cwd -- a bare temp dir keeps the probe cheap. */
  cwd: string
  /** Conversation name -- slugified into the DispatchSpec `seed.name`. */
  name: string
  /** The first-turn prompt. */
  prompt: string
  /** Model id (Haiku for the protocol smoke). */
  model: string
  /** When set, RESUME mode resumes this session id (fork:true, per the spike). */
  resumeFrom?: string
}

/**
 * Dispatch a daemon worker via the socket `dispatch` op; resolve its 8-hex
 * short id (the minted short, echoed by the daemon). Throws if no daemon
 * control socket is reachable or the dispatch op fails.
 */
export async function dispatchDaemonWorker(opts: DispatchOptions): Promise<string> {
  const sock = resolveControlSocket()
  if (!sock) throw new Error('dispatchDaemonWorker: no Claude Code daemon control socket reachable')
  const spec = buildDispatchSpec({
    mode: opts.resumeFrom ? 'resume' : 'new',
    short: randomBytes(4).toString('hex'),
    nonce: randomBytes(4).toString('hex'),
    sessionId: randomBytes(16).toString('hex'),
    cwd: opts.cwd,
    prompt: opts.prompt,
    resumeSessionId: opts.resumeFrom,
    model: opts.model,
    name: opts.name,
  })
  const resp = await dispatch(sock, spec)
  return resp.short
}

// ---------------------------------------------------------------------------
// runAttachStep -- attachWithRetry with the harness's logging wired in.
// ---------------------------------------------------------------------------

export interface AttachStepOptions {
  controlSock: string
  short: string
  cols?: number
  rows?: number
  onData?: (pty: Buffer) => void
  onClose?: (reason: AttachCloseReason) => void
  /** Progress log for retry attempts. */
  log?: (msg: string) => void
  /** Test seam: the attach implementation. Defaults to the real cc-daemon `attach`. */
  attachFn?: typeof attach
  maxAttempts?: number
  delayMs?: number
}

/** Attach to daemon worker `short`, retrying the transient ESTARTING/ENOJOB race. */
export function runAttachStep(opts: AttachStepOptions): Promise<AttachHandle> {
  return attachWithRetry(
    opts.controlSock,
    opts.short,
    {
      cols: opts.cols ?? DEFAULT_COLS,
      rows: opts.rows ?? DEFAULT_ROWS,
      onData: opts.onData ?? (() => {}),
      onClose: opts.onClose,
    },
    {
      attachFn: opts.attachFn,
      maxAttempts: opts.maxAttempts,
      delayMs: opts.delayMs,
      onRetry: (attempt, max, code) => opts.log?.(`attach retry ${attempt}/${max} (${code ?? 'transient'})`),
    },
  )
}

// ---------------------------------------------------------------------------
// fetchJobState -- one `list` call, the worker's current job state.
// ---------------------------------------------------------------------------

/** The current `JobRecord.state` for `short` via `list`, or null if absent. */
export async function fetchJobState(
  controlSock: string,
  short: string,
  listFn: (sock: string) => Promise<ListResponse> = list,
): Promise<string | null> {
  const resp = await listFn(controlSock)
  return resp.jobs.find(job => job.short === short)?.state ?? null
}

// ---------------------------------------------------------------------------
// mirrorWorker -- observe -> derive ccSessionId -> attach + transcript bridge.
// ---------------------------------------------------------------------------

export interface MirrorOptions {
  controlSock: string
  /** The 8-hex worker short to host. */
  short: string
  /** Launch mode -- decides where the observer derives the initial id from. */
  mode: DaemonMode
  /** Worker cwd -- the transcript-path slug source. */
  cwd: string
  /** The in-memory broker the transcript bridge mirrors into. */
  broker: InMemoryBroker
  log: SmokeLogger
  /** Fail if no ccSessionId is derived within this window. Default 60s. */
  bootstrapTimeoutMs?: number
}

export interface WorkerMirror {
  /** The first ccSessionId the session observer derived. */
  readonly ccSessionId: string
  /** The job state reported in the `attach` ack. */
  readonly attachState: string
  /** Stop the observer, transcript bridge and attach socket. Idempotent. */
  stop(): void
}

/**
 * Attach to `short` and mirror its transcript into `broker`, exactly as the
 * daemon-agent-host does in production. Resolves once the first ccSessionId is
 * derived and the attach + transcript bridge are live.
 */
export async function mirrorWorker(opts: MirrorOptions): Promise<WorkerMirror> {
  const { controlSock, short, mode, cwd, broker, log } = opts
  let attachHandle: AttachHandle | null = null
  let transcriptBridge: TranscriptBridge | null = null
  let observer: DaemonSessionObserver | null = null
  let firstId: string | null = null

  /** One-time setup once the worker's first ccSessionId is known. */
  async function bootstrap(id: string): Promise<string> {
    log.detail(`attaching to worker ${short} (mode=${mode}) ...`)
    attachHandle = await runAttachStep({ controlSock, short, log: msg => log.detail(msg) })
    log.detail(`attach ack: state=${attachHandle.ack.state} via=${attachHandle.ack.via}`)
    transcriptBridge = createTranscriptBridge({
      transport: broker.transport,
      conversationId: broker.conversationId,
    })
    await transcriptBridge.watch(id, cwd)
    log.detail(`transcript bridge watching ${id}.jsonl`)
    return attachHandle.ack.state
  }

  const ready = new Promise<{ id: string; state: string }>((resolve, reject) => {
    observer = observeDaemonSession({
      controlSock,
      daemonShort: short,
      mode,
      cwd,
      onSessionId: id => {
        if (firstId === null) {
          firstId = id
          log.detail(`session observer derived ccSessionId ${id}`)
          bootstrap(id).then(state => resolve({ id, state }), reject)
        } else {
          log.detail(`ccSessionId rotated -> ${id} (/clear)`)
          void transcriptBridge?.watch(id, cwd).catch(err => log.detail(`re-watch failed: ${(err as Error).message}`))
        }
      },
      onGone: () => log.detail(`worker ${short} left the daemon roster`),
      onError: err => log.detail(`observer error: ${err.message}`),
    })
  })

  const bootstrapTimeoutMs = opts.bootstrapTimeoutMs ?? 60_000
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`mirrorWorker: worker ${short} derived no ccSessionId within ${bootstrapTimeoutMs}ms`)),
      bootstrapTimeoutMs,
    )
  })

  const stop = (): void => {
    observer?.stop()
    transcriptBridge?.stop()
    attachHandle?.close()
  }

  try {
    const { id, state } = await Promise.race([ready, timeout])
    return { ccSessionId: id, attachState: state, stop }
  } catch (err) {
    stop()
    throw err
  }
}
