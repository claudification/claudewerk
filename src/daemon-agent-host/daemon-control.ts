/**
 * daemon-control -- routes the broker's remote-control verbs onto the
 * cc-daemon control socket.
 *
 * The control panel fires reply / kill / respawn-stale at a daemon-backed
 * conversation; the broker forwards each to this host, which owns the daemon
 * control socket. This module runs the matching daemon op and -- per the
 * EVERYTHING IS A STRUCTURED MESSAGE covenant -- emits a typed
 * `DaemonControlResult` for every op so the user sees the outcome (success
 * or the exact daemon error code: ENOREPLY, ENOJOB, EPROTO, ...).
 *
 * Verb mapping (plan-daemon-launch-ux.md Phase G):
 *   broker `input`                 -> daemon `reply`         (inject a turn)
 *   broker `terminate_conversation`-> daemon `kill`          (terminate worker)
 *   broker `daemon_respawn_stale`  -> daemon `respawn-stale`  (sleep/wake fix)
 *
 * `permission-response` is NOT applicable to a daemon worker: the dedicated
 * DaemonPermissionResponse contract + daemon `permission-response` op were
 * removed 2026-05-27 (sweep P1-2), and the op is dead-confirmed on 2.1.168
 * (no `requestId` is ever surfaced, so it can never be satisfied). Daemon
 * gates are conversational `state:blocked` questions answered by a free-text
 * reply via the chat box (the `input` -> `reply` path above). See
 * docs/daemon-mode.md + plan-daemon-launch-ux.md § 8 spike 5.
 *
 * Every op LOGS full context (op, conversationId, short, outcome, daemon
 * error code) per the LOG EVERYTHING covenant.
 */

import { controlResultFromError, controlResultFromResponse } from '../shared/cc-daemon/control-result'
import { kill as killOp, reply as replyOp, respawnStale as respawnStaleOp } from '../shared/cc-daemon/ops'
import type { DaemonResponse } from '../shared/cc-daemon/types'
import type { DaemonControlResult } from '../shared/protocol'

/** The daemon ops the control surface needs -- injectable so tests can fake them. */
export interface DaemonControlOps {
  reply(sockPath: string, short: string, text: string): Promise<DaemonResponse>
  kill(sockPath: string, short: string): Promise<DaemonResponse>
  respawnStale(sockPath: string, short: string): Promise<DaemonResponse>
}

/** The real cc-daemon ops -- used when no override is injected. */
const DEFAULT_OPS: DaemonControlOps = { reply: replyOp, kill: killOp, respawnStale: respawnStaleOp }

export interface DaemonControlDeps {
  /** Path to the cc-daemon control socket. */
  controlSock: string
  /** 8-hex short id of the worker this host is bound to. */
  daemonShort: string
  /** Stable conversation id -- stamped onto every result. */
  conversationId: string
  /** Emit a structured result onto the broker wire (`transport.send`). */
  emit: (result: DaemonControlResult) => void
  /** Engineer-facing log sink. */
  log: (msg: string) => void
  /** Injected daemon ops -- defaults to the real cc-daemon ops. */
  ops?: DaemonControlOps
}

export interface DaemonControl {
  /** Inject `text` into the worker as a turn (daemon `reply`). */
  reply(text: string): Promise<DaemonControlResult>
  /** Switch the worker's model live via a `/model <name>` reply (spike 3b: works). */
  setModel(model: string): Promise<DaemonControlResult>
  /** Terminate the worker (daemon `kill`). */
  kill(): Promise<DaemonControlResult>
  /** Respawn a sleep/wake-stale worker (daemon `respawn-stale`). */
  respawnStale(): Promise<DaemonControlResult>
}

/**
 * Build the remote-control surface for one daemon-backed conversation. Each
 * verb runs its daemon op, builds a `DaemonControlResult`, logs the outcome
 * and emits the result -- it never rejects (a thrown op error becomes a
 * failure result, so callers can fire-and-forget).
 */
export function createDaemonControl(deps: DaemonControlDeps): DaemonControl {
  const { controlSock, daemonShort, conversationId, emit, log } = deps
  const ops = deps.ops ?? DEFAULT_OPS
  const idTag = `conv=${conversationId.slice(0, 8)} short=${daemonShort}`

  /** Run one op, build + emit the structured result, log full context. */
  async function run(
    op: DaemonControlResult['op'],
    exec: () => Promise<DaemonResponse>,
    intent: string,
  ): Promise<DaemonControlResult> {
    log(`[daemon-control] op=${op} ${idTag} -- ${intent}`)
    let result: DaemonControlResult
    try {
      result = controlResultFromResponse(conversationId, op, await exec())
    } catch (err) {
      // request() throws on EPROTO (proto gate), timeout and dead socket.
      result = controlResultFromError(conversationId, op, err)
    }
    if (result.ok) {
      log(`[daemon-control] op=${op} ${idTag} -> ok`)
    } else {
      log(`[daemon-control] op=${op} ${idTag} -> FAIL code=${result.code ?? '-'} detail=${result.detail ?? '-'}`)
    }
    emit(result)
    return result
  }

  return {
    reply: text => run('reply', () => ops.reply(controlSock, daemonShort, text), `inject turn (${text.length} chars)`),
    setModel: model =>
      run('set_model', () => ops.reply(controlSock, daemonShort, `/model ${model}`), `switch model -> ${model}`),
    kill: () => run('kill', () => ops.kill(controlSock, daemonShort), 'terminate worker'),
    respawnStale: () => run('respawn_stale', () => ops.respawnStale(controlSock, daemonShort), 'respawn stale worker'),
  }
}
