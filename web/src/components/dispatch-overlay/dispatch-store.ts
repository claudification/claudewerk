/**
 * Dispatch overlay state (the per-user cockpit's brain).
 *
 * Eager + light: must be live before the overlay first opens so broadcast frames
 * are captured. Owns the intent draft, decision feed, streamed tool gears, model
 * choice, near-memory threads, durable memory, and scratch workspaces. All WS
 * traffic goes through `wsSend` + the inbound handlers in use-websocket-handlers.
 * `userId` (stamped by the broker WS seam) scopes everything per user.
 */

import type {
  DispatchCandidate,
  DispatchDecision,
  DispatchThread,
  DispatchToolCall,
  DispatchToolResult,
} from '@shared/protocol'
import { create } from 'zustand'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { dispatchBus } from './dispatch-bus'
import {
  appendToolCall,
  DISPATCH_MODELS,
  type DispatchToolEvent,
  mergeDecision,
  resolveToolResult,
  type WorkspaceInfo,
} from './dispatch-models'

export type RightPane = 'memory' | 'conversation' | 'workspace'

interface DispatchState {
  open: boolean
  userId: string | null
  intent: string
  /** Session feed of decisions, most-recent first. */
  decisions: DispatchDecision[]
  pending: boolean
  lastError: string | null
  threads: DispatchThread[]
  /** Live conversations the desk currently covers (shown as "active right now"). */
  roster: DispatchCandidate[]
  threadsLoading: boolean
  activeConvId: string | null
  rightPane: RightPane
  /** Model the agent loop runs on (slug). User-switchable; sent per request. */
  model: string
  /** Streamed tool calls/results keyed by the turn's traceId (the dimmed gears). */
  toolEvents: Record<string, DispatchToolEvent[]>
  /** Whether the near-memory threads board is shown (toggle). */
  showThreads: boolean
  /** The dispatcher's durable memory file (markdown), for inspection. */
  memory: string
  /** The dispatcher's virtual-fs scratch workspaces (/work/<x>). */
  workspaces: WorkspaceInfo[]

  // intent / submission
  setIntent(intent: string): void
  setModel(slug: string): void
  toggleThreads(): void
  submit(override?: { target?: string; disposition?: 'route' | 'revive' | 'new'; confirmedExpensive?: boolean }): void
  confirmExpensive(decision: DispatchDecision): void
  chooseCandidate(candidate: DispatchCandidate, ended?: boolean): void

  // near-memory
  fetchThreads(): void

  // navigation
  openOverlay(): void
  closeOverlay(): void
  selectConv(id: string | null): void
  setRightPane(pane: RightPane): void
  /** "Take me here": hand off to the conversation in the app, close the desk. */
  routeTo(id: string): void

  // inbound (called by the WS handlers)
  onRequestResult(msg: { ok?: boolean; error?: string; decision?: DispatchDecision }): void
  onThreadsResult(msg: {
    threads?: DispatchThread[]
    roster?: DispatchCandidate[]
    memory?: string
    workspaces?: WorkspaceInfo[]
    userId?: string | null
  }): void
  onDecisionBroadcast(decision: DispatchDecision): void
  onToolCall(msg: DispatchToolCall): void
  onToolResult(msg: DispatchToolResult): void
}

let reqSeq = 0
const nextRequestId = () => `dreq_${Date.now().toString(36)}_${++reqSeq}`

export const useDispatchStore = create<DispatchState>((set, get) => ({
  open: false,
  userId: null,
  intent: '',
  decisions: [],
  pending: false,
  lastError: null,
  threads: [],
  roster: [],
  threadsLoading: false,
  activeConvId: null,
  rightPane: 'memory',
  model: DISPATCH_MODELS[0].slug,
  toolEvents: {},
  showThreads: true,
  memory: '',
  workspaces: [],

  setIntent: intent => set({ intent }),
  setModel: slug => set({ model: slug }),
  toggleThreads: () => set(s => ({ showThreads: !s.showThreads })),

  submit: override => {
    const intent = get().intent.trim()
    if (!intent || get().pending) return
    const requestId = nextRequestId()
    // Clear the input the moment we send -- "on ask/Enter the input must clear".
    set({ pending: true, lastError: null, intent: '' })
    wsSend('dispatch_request', { intent, requestId, model: get().model, ...override })
  },

  confirmExpensive: decision => {
    const requestId = nextRequestId()
    set({ pending: true, lastError: null })
    wsSend('dispatch_request', {
      intent: decision.intent,
      requestId,
      target: decision.target,
      disposition: decision.disposition === 'ask' ? undefined : decision.disposition,
      confirmedExpensive: true,
    })
  },

  chooseCandidate: (candidate, ended) => {
    const intent = get().intent.trim() || get().decisions[0]?.intent
    if (!intent) return
    const requestId = nextRequestId()
    set({ pending: true, lastError: null })
    wsSend('dispatch_request', {
      intent,
      requestId,
      target: candidate.conversationId,
      disposition: ended ? 'revive' : 'route',
    })
  },

  fetchThreads: () => {
    if (get().threadsLoading) return
    set({ threadsLoading: true })
    wsSend('dispatch_list_threads', { requestId: nextRequestId() })
  },

  openOverlay: () => {
    dispatchBus.open() // arm the lazy mount (first open fetches the chunk)
    set({ open: true })
    get().fetchThreads()
  },
  closeOverlay: () => set({ open: false }),
  selectConv: id => set({ activeConvId: id, rightPane: id ? 'conversation' : 'memory' }),
  setRightPane: pane => set({ rightPane: pane }),
  routeTo: id => {
    useConversationsStore.getState().selectConversation(id, 'dispatch')
    set({ open: false })
  },

  onRequestResult: msg => {
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

  onThreadsResult: msg =>
    set(s => ({
      threadsLoading: false,
      threads: msg.threads ?? [],
      roster: msg.roster ?? [],
      memory: msg.memory ?? '',
      workspaces: msg.workspaces ?? [],
      userId: msg.userId ?? s.userId,
    })),

  // Broadcast frames (every decision, incl. other surfaces). Fold them into the
  // feed so the cockpit reflects dispatcher activity even if it wasn't the caller.
  onDecisionBroadcast: decision => set(s => ({ decisions: mergeDecision(s.decisions, decision) })),

  // Streamed gears: append the call (running), then resolve it on its result.
  onToolCall: msg => set(s => ({ toolEvents: appendToolCall(s.toolEvents, msg) })),
  onToolResult: msg => set(s => ({ toolEvents: resolveToolResult(s.toolEvents, msg) })),
}))
