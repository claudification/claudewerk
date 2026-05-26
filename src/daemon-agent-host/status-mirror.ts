/**
 * status-mirror -- mirror a daemon worker's `subscribe` state stream to the
 * broker as structured status (transport-reframe Phase 7, control surface
 * uplift #12d).
 *
 * The PTY bridge (broker-bridge.ts) carries only raw terminal bytes, so the
 * control panel had to SCRAPE the PTY to guess whether a daemon worker was
 * working / done. The cc-daemon `subscribe` op exposes the worker's own
 * state-machine (`state`, `tempo`, `detail`, `needs`) as typed patches. This
 * module opens a second (read-only) `subscribe` connection and translates each
 * state patch into:
 *   - `daemon_state_patch`  -- the granular typed patch (for the detail/JsonInspector)
 *   - `conversation_status` -- the coarse active/idle signal, now carrying the
 *                              richer daemonState + detail vocab (#12d uplift)
 *   - `daemon_block_observed` -- when a worker surfaces an interaction gate
 *                              (DEFENSIVE -- dormant in the auto-accept fleet
 *                              config per the Phase 7 live spikes 3d/3e)
 *
 * The translation (`translatePatch`) is pure + unit-tested; the I/O wrapper
 * (`createStatusMirror`) holds the subscribe handle + the dedup state.
 */

import { isSnapshot, type SubscribeCloseReason, type SubscribeHandle, subscribe } from '../shared/cc-daemon/subscribe'
import type {
  AgentHostMessage,
  ConversationStatusSignal,
  DaemonBlockObserved,
  DaemonRunState,
  DaemonStatePatch,
} from '../shared/protocol'

const RUN_STATES: ReadonlySet<string> = new Set([
  'running',
  'working',
  'blocked',
  'resuming',
  'failed',
  'done',
  'crashed',
])

/** The states that mean "this conversation is NOT actively doing work". */
const IDLE_STATES: ReadonlySet<DaemonRunState> = new Set<DaemonRunState>(['done', 'failed', 'crashed'])

function asRunState(v: unknown): DaemonRunState | undefined {
  return typeof v === 'string' && RUN_STATES.has(v) ? (v as DaemonRunState) : undefined
}

function asTempo(v: unknown): 'active' | 'idle' | undefined {
  return v === 'active' || v === 'idle' ? v : undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Map the daemon run-state + tempo to the coarse conversation active/idle
 * signal.
 *
 * `tempo:'idle'` is the daemon's per-turn STOP signal -- the turn ended and the
 * worker is alive awaiting input. It is the closest daemon equivalent of the
 * headless `Stop` hook / `end_turn`, and is exactly what makes a finished-but-
 * alive worker stop showing "running". A terminal `state` (done/failed/crashed)
 * is idle too. Everything else is active.
 *
 * This honors the documented ConversationStatusSignal contract ("status is
 * derived from the daemon tempo") -- before this, status keyed on `state` alone,
 * so a worker sitting at `state:running, tempo:idle` between turns stayed
 * "active" forever.
 */
function statusFromState(state: DaemonRunState | undefined, tempo: 'active' | 'idle' | undefined): 'active' | 'idle' {
  if (state && IDLE_STATES.has(state)) return 'idle'
  if (tempo === 'idle') return 'idle'
  return 'active'
}

/** Build the granular typed patch from a raw subscribe `state` patch. Optional
 *  fields are left undefined (JSON drops them); each branch lives in an `asX` helper. */
function toStatePatch(conversationId: string, patch: Record<string, unknown>, now: number): DaemonStatePatch {
  return {
    type: 'daemon_state_patch',
    conversationId,
    state: asRunState(patch.state),
    tempo: asTempo(patch.tempo),
    detail: asString(patch.detail),
    needs: asString(patch.needs),
    raw: patch,
    t: now,
  }
}

/** True when a patch carries any field the mirror cares about (skip pure {pid} churn). */
function hasMeaningfulField(patch: Record<string, unknown>): boolean {
  return ['state', 'tempo', 'detail', 'needs'].some(k => patch[k] !== undefined)
}

/** True when a patch indicates the worker is at an interaction gate. */
function isBlockedPatch(patch: Record<string, unknown>): boolean {
  if (patch.state === 'blocked') return true
  if (patch.block != null) return true
  return !!asString(patch.needs)
}

/** Extract the permission-response correlator from a `block:{requestId}` object. */
function blockRequestId(block: unknown): string | undefined {
  return block && typeof block === 'object' ? asString((block as Record<string, unknown>).requestId) : undefined
}

/** Build daemon_block_observed when the patch indicates an interaction gate, else null. */
function toBlockObserved(
  conversationId: string,
  patch: Record<string, unknown>,
  now: number,
): DaemonBlockObserved | null {
  if (!isBlockedPatch(patch)) return null
  const block = patch.block
  return {
    type: 'daemon_block_observed',
    conversationId,
    needs: asString(patch.needs),
    requestId: blockRequestId(block),
    raw: block !== undefined && block !== null ? { block } : undefined,
    t: now,
  }
}

/** The mirror's carried state for conversation_status dedup. */
export interface MirrorState {
  state?: DaemonRunState
  tempo?: 'active' | 'idle'
  detail?: string
}

/** Fold a raw patch over the prior coarse state, carrying unchanged fields. */
function foldState(patch: Record<string, unknown>, prev: MirrorState): MirrorState {
  return {
    state: asRunState(patch.state) ?? prev.state,
    tempo: asTempo(patch.tempo) ?? prev.tempo,
    detail: asString(patch.detail) ?? prev.detail,
  }
}

/** True when the coarse state (state/tempo/detail) differs from the prior. */
function stateChanged(next: MirrorState, prev: MirrorState): boolean {
  return next.state !== prev.state || next.tempo !== prev.tempo || next.detail !== prev.detail
}

/** Build a conversation_status signal from the folded state, or null when there is nothing to report. */
function toStatusSignal(conversationId: string, next: MirrorState): ConversationStatusSignal | null {
  if (next.state === undefined && next.tempo === undefined) return null
  return {
    type: 'conversation_status',
    conversationId,
    status: statusFromState(next.state, next.tempo),
    daemonState: next.state,
    detail: next.detail || undefined,
  }
}

/**
 * PURE translation of one raw `subscribe` state patch into the messages to emit,
 * plus the next dedup state. `daemon_state_patch` rides for every meaningful
 * patch; `conversation_status` only when state/tempo/detail changed (dedup);
 * `daemon_block_observed` only at a gate.
 */
export function translatePatch(
  conversationId: string,
  patch: Record<string, unknown>,
  prev: MirrorState,
  now: number,
): { messages: AgentHostMessage[]; next: MirrorState } {
  if (!hasMeaningfulField(patch)) return { messages: [], next: prev }
  const next = foldState(patch, prev)
  const signal = stateChanged(next, prev) ? toStatusSignal(conversationId, next) : null
  const candidates: Array<AgentHostMessage | null> = [
    toStatePatch(conversationId, patch, now),
    toBlockObserved(conversationId, patch, now),
    signal,
  ]
  return { messages: candidates.filter((m): m is AgentHostMessage => m !== null), next }
}

export interface StatusMirrorDeps {
  controlSock: string
  daemonShort: string
  conversationId: string
  /** Forward a translated message to the broker (transport.send). */
  send: (msg: AgentHostMessage) => void
  log?: (msg: string) => void
}

export interface StatusMirror {
  /** Close the subscribe connection. Idempotent. */
  stop(): void
}

/** Bounded re-subscribe backoff (ms). The index clamps to the last entry. */
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000] as const

/**
 * PURE: how long to wait before re-subscribing after a subscribe close, or
 * `null` to give up.
 *
 * `client-closed` is our own `stop()` -- never retry. `daemon-error` is
 * ENOJOB/EPROTO (the worker is gone or the protocol mismatched) -- the
 * session-observer owns worker-gone, so the mirror does not spin re-subscribing.
 * Transient transport closes (socket-closed/socket-error/parse-error/
 * connect-timeout) retry with bounded backoff so a blip does not permanently
 * stop the status stream.
 */
export function mirrorRetryDelayMs(reason: SubscribeCloseReason, attempt: number): number | null {
  if (reason === 'client-closed' || reason === 'daemon-error') return null
  if (attempt >= RETRY_DELAYS_MS.length) return null
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? null
}

/**
 * Open a read-only `subscribe` connection on the daemon worker and forward the
 * translated status messages to the broker.
 *
 * SELF-HEALING: a transient transport drop re-subscribes with bounded backoff
 * (a blip must not permanently stop the status stream -- the status-mirror is
 * the sole status authority for a hosted daemon conversation). A worker-gone
 * close (`daemon-error`/ENOJOB) does NOT retry -- the session-observer owns that
 * and ends the conversation. Best-effort throughout: it never throws, and the
 * PTY bridge keeps working regardless. Every non-client close is logged
 * (LOG EVERYTHING) via the daemon-host's always-on logger.
 */
export function createStatusMirror(deps: StatusMirrorDeps): StatusMirror {
  const { controlSock, daemonShort, conversationId, send, log } = deps
  const convShort = conversationId.slice(0, 8)
  let prev: MirrorState = {}
  let handle: SubscribeHandle | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let stopped = false

  function open(): void {
    handle = subscribe(controlSock, daemonShort, {
      onEvent: frame => {
        attempt = 0 // a live frame means the subscription is healthy -- reset backoff
        // The snapshot's `record` is a full JobRecord; treat it as the initial patch.
        const patch = isSnapshot(frame)
          ? (frame.record as unknown as Record<string, unknown>)
          : ((frame as { patch?: Record<string, unknown> }).patch ?? {})
        const { messages, next } = translatePatch(conversationId, patch, prev, Date.now())
        prev = next
        for (const msg of messages) send(msg)
      },
      onClose: reason => {
        if (stopped || reason === 'client-closed') return
        const delay = mirrorRetryDelayMs(reason, attempt)
        if (delay === null) {
          log?.(`status-mirror: subscribe ended (${reason}) conv=${convShort} short=${daemonShort} -- not retrying`)
          return
        }
        attempt += 1
        log?.(
          `status-mirror: subscribe lost (${reason}) conv=${convShort} short=${daemonShort} -- ` +
            `re-subscribing in ${delay}ms (attempt ${attempt}/${RETRY_DELAYS_MS.length})`,
        )
        retryTimer = setTimeout(() => {
          if (!stopped) open()
        }, delay)
      },
      onError: err => log?.(`status-mirror: subscribe error: ${err.message} conv=${convShort} short=${daemonShort}`),
    })
  }

  open()

  return {
    stop: () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      handle?.close()
    },
  }
}
