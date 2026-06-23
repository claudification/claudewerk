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
  DispatchHistoryDump,
  DispatchProjectMemory,
  DispatchThread,
  DispatchToolCall,
  DispatchToolResult,
} from '@shared/protocol'
import { create } from 'zustand'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { dispatchBus } from './dispatch-bus'
import { createInbound, type ThreadsResultMsg } from './dispatch-inbound'
import { DISPATCH_MODELS, type DispatchToolEvent, type WorkspaceInfo } from './dispatch-models'

export type RightPane = 'memory' | 'conversation' | 'workspace'

export interface DispatchState {
  open: boolean
  userId: string | null
  intent: string
  /** The streamed living HISTORY -- the SOURCE OF TRUTH for the conversation
   *  (persistent transcript + state blocks). Seeded on open, replaced live. */
  history: DispatchHistoryDump | null
  /** Session feed of decisions, most-recent first. Kept for in-flight tool gears
   *  + interactive affordances (candidate pick / expensive confirm), not the feed. */
  decisions: DispatchDecision[]
  /** The trace id of the in-flight turn, so the flow can show its live gears. */
  activeTraceId: string | null
  pending: boolean
  lastError: string | null
  threads: DispatchThread[]
  /** The fleet by project + condensed memory (the project-anchored brain view). */
  projects: DispatchProjectMemory[]
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
  /** VERBOSE view (Slice D): expose the dispatcher's full internal state -- the
   *  live XML state blocks, decision metadata, and per-turn tool frames. */
  verbose: boolean
  /** The dispatcher's durable memory file (markdown), for inspection. */
  memory: string
  /** The dispatcher's virtual-fs scratch workspaces (/work/<x>). */
  workspaces: WorkspaceInfo[]

  // intent / submission
  setIntent(intent: string): void
  setModel(slug: string): void
  toggleThreads(): void
  toggleVerbose(): void
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

  // inbound (called by the WS handlers; implemented in dispatch-inbound)
  onRequestResult(msg: { ok?: boolean; error?: string; decision?: DispatchDecision }): void
  onThreadsResult(msg: ThreadsResultMsg): void
  onHistory(msg: { history?: DispatchHistoryDump; userId?: string | null }): void
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
  history: null,
  decisions: [],
  activeTraceId: null,
  pending: false,
  lastError: null,
  threads: [],
  projects: [],
  roster: [],
  threadsLoading: false,
  activeConvId: null,
  rightPane: 'memory',
  model: DISPATCH_MODELS[0].slug,
  toolEvents: {},
  showThreads: true,
  verbose: false,
  memory: '',
  workspaces: [],

  setIntent: intent => set({ intent }),
  setModel: slug => set({ model: slug }),
  toggleThreads: () => set(s => ({ showThreads: !s.showThreads })),
  toggleVerbose: () => set(s => ({ verbose: !s.verbose })),

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

  // inbound WS reducers (history seed/stream, decision feed, tool gears)
  ...createInbound(set, get),
}))
