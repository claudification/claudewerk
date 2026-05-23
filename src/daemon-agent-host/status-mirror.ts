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

import { isSnapshot, type SubscribeHandle, subscribe } from '../shared/cc-daemon/subscribe'
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

/** Map the daemon run-state to the coarse conversation active/idle signal. */
function statusFromState(state: DaemonRunState | undefined): 'active' | 'idle' {
  return state && IDLE_STATES.has(state) ? 'idle' : 'active'
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
    status: statusFromState(next.state),
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

/**
 * Open a read-only `subscribe` connection on the daemon worker and forward the
 * translated status messages to the broker. Best-effort: a missing socket or a
 * subscribe error simply ends the mirror (logged) -- it never throws, and the
 * PTY bridge keeps working regardless.
 */
export function createStatusMirror(deps: StatusMirrorDeps): StatusMirror {
  const { controlSock, daemonShort, conversationId, send, log } = deps
  let prev: MirrorState = {}

  const handle: SubscribeHandle = subscribe(controlSock, daemonShort, {
    onEvent: frame => {
      // The snapshot's `record` is a full JobRecord; treat it as the initial patch.
      const patch = isSnapshot(frame)
        ? (frame.record as unknown as Record<string, unknown>)
        : ((frame as { patch?: Record<string, unknown> }).patch ?? {})
      const { messages, next } = translatePatch(conversationId, patch, prev, Date.now())
      prev = next
      for (const msg of messages) send(msg)
    },
    onClose: reason => log?.(`status-mirror: subscribe closed (${reason}) short=${daemonShort}`),
    onError: err => log?.(`status-mirror: subscribe error: ${err.message} short=${daemonShort}`),
  })

  return {
    stop: () => handle.close(),
  }
}
