/**
 * Dispatch overlay state (the per-user cockpit's brain).
 *
 * Eager + light by design: the heavy UI is lazy, but this store must be live
 * before the overlay first opens so broadcast `dispatch_decision` frames are
 * captured. It owns the intent draft, the session decision feed, the near-memory
 * threads, and the selected conversation. All WS traffic goes through `wsSend`
 * (client->broker) and the inbound handlers wired into use-websocket-handlers.
 *
 * Per-user scoping: the broker WS seam stamps `userId` (the authed connection)
 * on every decision/threads reply; we surface it so the cockpit shows whose
 * dispatch this is. When the backend store gains a user_id column the same
 * field filters server-side -- drop-in, no client change.
 */

import type { DispatchCandidate, DispatchDecision, DispatchThread } from '@shared/protocol'
import { create } from 'zustand'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { dispatchBus } from './dispatch-bus'

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
  threadsLoading: boolean
  activeConvId: string | null
  rightPane: RightPane

  // intent / submission
  setIntent(intent: string): void
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
  onThreadsResult(msg: { threads?: DispatchThread[]; userId?: string | null }): void
  onDecisionBroadcast(decision: DispatchDecision): void
}

let reqSeq = 0
const nextRequestId = () => `dreq_${Date.now().toString(36)}_${++reqSeq}`

/** Merge a decision into the feed, de-duping by decisionId (a confirm/resolve
 *  replaces the held card rather than stacking a duplicate). */
function mergeDecision(feed: DispatchDecision[], decision: DispatchDecision): DispatchDecision[] {
  const without = feed.filter(d => d.decisionId !== decision.decisionId)
  return [decision, ...without].slice(0, 40)
}

export const useDispatchStore = create<DispatchState>((set, get) => ({
  open: false,
  userId: null,
  intent: '',
  decisions: [],
  pending: false,
  lastError: null,
  threads: [],
  threadsLoading: false,
  activeConvId: null,
  rightPane: 'memory',

  setIntent: intent => set({ intent }),

  submit: override => {
    const intent = get().intent.trim()
    if (!intent || get().pending) return
    const requestId = nextRequestId()
    set({ pending: true, lastError: null })
    wsSend('dispatch_request', { intent, requestId, ...override })
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
      userId: msg.userId ?? s.userId,
    })),

  // Broadcast frames (every decision, incl. other surfaces). Fold them into the
  // feed so the cockpit reflects dispatcher activity even if it wasn't the caller.
  onDecisionBroadcast: decision => set(s => ({ decisions: mergeDecision(s.decisions, decision) })),
}))

/**
 * Expose an imperative control surface on `window.__dispatch` so the `web_*`
 * remote-control tools (web_execute_script) can OPEN the cockpit, READ its
 * current state, and SUBMIT an intent for debugging. First-class debug seam.
 */
export function exposeDispatchControl(): void {
  if (typeof window === 'undefined') return
  const api = {
    open: () => useDispatchStore.getState().openOverlay(),
    close: () => useDispatchStore.getState().closeOverlay(),
    submit: (intent: string) => {
      useDispatchStore.getState().setIntent(intent)
      useDispatchStore.getState().submit()
    },
    setIntent: (intent: string) => useDispatchStore.getState().setIntent(intent),
    fetchThreads: () => useDispatchStore.getState().fetchThreads(),
    selectConv: (id: string | null) => useDispatchStore.getState().selectConv(id),
    /** A JSON-serialisable snapshot of what the cockpit is showing right now. */
    state: () => {
      const s = useDispatchStore.getState()
      return {
        open: s.open,
        userId: s.userId,
        intent: s.intent,
        pending: s.pending,
        lastError: s.lastError,
        rightPane: s.rightPane,
        activeConvId: s.activeConvId,
        decisionCount: s.decisions.length,
        latestDecision: s.decisions[0] ?? null,
        threads: s.threads.map(t => ({
          id: t.id,
          title: t.title,
          summary: t.summary,
          conversations: t.conversations.length,
          updatedAt: t.updatedAt,
        })),
      }
    },
  }
  ;(window as unknown as { __dispatch?: typeof api }).__dispatch = api
}
