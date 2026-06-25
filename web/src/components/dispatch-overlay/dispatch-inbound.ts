/**
 * The dispatch overlay's WS INBOUND reducers -- one place that folds every server
 * message into the store. Split out of dispatch-store so the store file stays a
 * lean state + outbound-actions definition; this owns the receiving side.
 *
 * The streamed living HISTORY is the SOURCE OF TRUTH for the conversation (Slice
 * B/C): `dispatch_history` (live, all devices) and the `history` on a threads
 * result (load-on-open) both flow through `onHistory`. The `decisions` feed is
 * kept only for in-flight tool gears + interactive affordances (pick / confirm).
 */

import type {
  DispatchCandidate,
  DispatchDecision,
  DispatchHistoryDump,
  DispatchToolCall,
  DispatchToolResult,
} from '@shared/protocol'
import { appendToolCall, mergeDecision, resolveToolResult, type WorkspaceInfo } from './dispatch-models'
import type { DispatchState } from './dispatch-store'

type Set = (partial: Partial<DispatchState> | ((s: DispatchState) => Partial<DispatchState>)) => void
type Get = () => DispatchState

export interface ThreadsResultMsg {
  /** Present (and false) only on a router-level failure reply (a thrown handler,
   *  e.g. permission denied), which comes back as the same conventional type. */
  ok?: boolean
  error?: string
  roster?: DispatchCandidate[]
  memory?: string
  workspaces?: WorkspaceInfo[]
  history?: DispatchHistoryDump
  userId?: string | null
}

/** Build the inbound-handler slice of the store (closes over zustand set/get). */
export function createInbound(set: Set, get: Get) {
  return {
    onRequestResult: (msg: { ok?: boolean; error?: string; decision?: DispatchDecision }) => {
      if (msg.ok && msg.decision) {
        set(s => ({
          pending: false,
          lastError: null,
          userId: msg.decision?.userId ?? s.userId,
          decisions: mergeDecision(s.decisions, msg.decision as DispatchDecision),
        }))
        // A resolved decision may have produced a conversation -- pull fresh memory.
        if (msg.decision.executed) get().fetchThreads()
      } else {
        set({ pending: false, lastError: msg.error ?? 'dispatch failed' })
      }
    },

    onThreadsResult: (msg: ThreadsResultMsg) => {
      // A router-level failure (thrown handler -- e.g. the `spawn` permission gate)
      // arrives as the SAME conventional `${type}_result` with ok:false and no
      // payload. Clear the loading flag + surface it; do NOT wipe the desk to blanks.
      if (msg.ok === false) {
        set({ threadsLoading: false, lastError: msg.error ?? 'failed to load the desk' })
        return
      }
      set(s => ({
        threadsLoading: false,
        roster: msg.roster ?? [],
        memory: msg.memory ?? '',
        workspaces: msg.workspaces ?? [],
        history: msg.history ?? s.history, // seed the living conversation on open (Slice C)
        userId: msg.userId ?? s.userId,
      }))
    },

    // The streamed living history -- replace in place so every device stays in
    // lockstep on the same continuously-updating state (Slice B/C).
    onHistory: (msg: { history?: DispatchHistoryDump; userId?: string | null }) =>
      set(s => ({ history: msg.history ?? s.history, userId: msg.userId ?? s.userId })),

    // Broadcast frames (every decision, incl. other surfaces). Fold them into the
    // feed so the cockpit reflects dispatcher activity even if it wasn't the caller.
    onDecisionBroadcast: (decision: DispatchDecision) =>
      set(s => ({ decisions: mergeDecision(s.decisions, decision) })),

    // Streamed gears: append the call (running), then resolve it on its result.
    // Track the active turn's trace so the flow can show its live gears.
    onToolCall: (msg: DispatchToolCall) =>
      set(s => ({ toolEvents: appendToolCall(s.toolEvents, msg), activeTraceId: msg.traceId })),
    onToolResult: (msg: DispatchToolResult) => set(s => ({ toolEvents: resolveToolResult(s.toolEvents, msg) })),
  }
}
