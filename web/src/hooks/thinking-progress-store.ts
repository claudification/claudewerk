/**
 * Per-conversation live thinking-progress state.
 *
 * Lives OUTSIDE Zustand (like `token-flow-store.ts` / `ws-stats.ts`) so the
 * high-frequency live ping stream never triggers a Zustand update or a
 * re-render storm. Consumers read via useSyncExternalStore.
 *
 * EPHEMERAL by design: never persisted, never replayed. Each ping is
 * dropped after the staleness window. When the user switches conversations
 * or an assistant turn lands, the entry can be cleared explicitly.
 */

import { createExternalStoreSignal } from './external-store-utils'

const SAMPLE_RING_SIZE = 16
/** Idle period after which a conversation's pill is considered stale and cleared. */
const STALE_TIMEOUT_MS = 4000
/** Coalesced notify cadence so a fast stream of pings doesn't thrash React. */
const NOTIFY_TICK_MS = 250

export interface ThinkingSample {
  /** Cumulative tokens at the time of this ping. */
  tokens: number
  /** Delta from the previous ping (or undefined on the first). */
  delta?: number
  /** Wall-clock receive time, ms since epoch. */
  t: number
}

export interface ThinkingProgressEntry {
  /** Ring of recent samples (most recent at the end). */
  samples: ThinkingSample[]
  /** Receive time of the most recent ping. */
  lastTickAt: number
  /** First-ping receive time -- used to label "thinking for Xs". */
  startedAt: number
}

const state = new Map<string, ThinkingProgressEntry>()
const signal = createExternalStoreSignal()
let dirty = false

function pruneStale(now: number): boolean {
  let changed = false
  for (const [convId, entry] of state) {
    if (now - entry.lastTickAt > STALE_TIMEOUT_MS) {
      state.delete(convId)
      changed = true
    }
  }
  return changed
}

setInterval(() => {
  const stalePruned = pruneStale(Date.now())
  if (!dirty && !stalePruned) return
  dirty = false
  signal.bump()
}, NOTIFY_TICK_MS)

export function recordThinkingProgress(conversationId: string, sample: ThinkingSample): void {
  let entry = state.get(conversationId)
  if (!entry) {
    entry = { samples: [], lastTickAt: sample.t, startedAt: sample.t }
    state.set(conversationId, entry)
  }
  entry.samples.push(sample)
  if (entry.samples.length > SAMPLE_RING_SIZE) {
    entry.samples.shift()
  }
  entry.lastTickAt = sample.t
  dirty = true
}

/** Clear the live state for a conversation. Called when a new transcript
 *  entry lands -- the model has finished thinking. */
export function clearThinkingProgress(conversationId: string): void {
  if (!state.has(conversationId)) return
  state.delete(conversationId)
  dirty = true
}

export const subscribe = signal.subscribe
export const getVersion = signal.getVersion

export function getThinkingProgress(conversationId: string): ThinkingProgressEntry | undefined {
  return state.get(conversationId)
}
