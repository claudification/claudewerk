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
  DispatchProjectStatus,
  DispatchToolCall,
  DispatchToolResult,
} from '@shared/protocol'
import { create } from 'zustand'
import { useConversationsStore, wsSend } from '@/hooks/use-conversations'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
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
  /** Live conversations the desk currently covers (shown as "active right now"). */
  roster: DispatchCandidate[]
  /** Per-project status (Phase 4b): the "where things stand" strip on open. */
  status: DispatchProjectStatus[]
  threadsLoading: boolean
  activeConvId: string | null
  rightPane: RightPane
  /** Model the agent loop runs on (slug). User-switchable; sent per request. */
  model: string
  /** Streamed tool calls/results keyed by the turn's traceId (the dimmed gears). */
  toolEvents: Record<string, DispatchToolEvent[]>
  /** VERBOSE view (Slice D): expose the dispatcher's full internal state -- the
   *  live XML state blocks, decision metadata, and per-turn tool frames. */
  verbose: boolean
  /** The dispatcher's durable memory file (markdown), for inspection. */
  memory: string
  /** The dispatcher's virtual-fs scratch workspaces (/work/<x>). */
  workspaces: WorkspaceInfo[]

  /** Editor modal state for /memory and /system. */
  editorModal: { kind: 'memory' | 'system'; content: string } | null
  /** Refine preview state for /memory x. */
  refinePreview: { before: string; after: string; model: string } | null
  /** SotU debug modal data. */
  sotuDump: unknown | null

  // intent / submission
  setIntent(intent: string): void
  setModel(slug: string): void
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
  onControlResult(msg: {
    action?: string
    content?: string
    before?: string
    after?: string
    model?: string
    ok?: boolean
    error?: string
  }): void
  closeEditor(): void
  saveEditor(content: string): void
  confirmRefine(): void
  cancelRefine(): void
  closeSotu(): void
}

let reqSeq = 0
const nextRequestId = () => `dreq_${Date.now().toString(36)}_${++reqSeq}`

/** Slash-commands the user can type to RESET the dispatcher (a `dispatch_control`
 *  verb, not an intent for the agent loop). The broker performs the verb + re-syncs
 *  every device live. `/clear` wipes everything, `/compact` folds the window into
 *  memory now, `/forget` drops the long-term memory only. */
const SLASH_CONTROL: Record<string, 'clear' | 'compact' | 'forget'> = {
  '/clear': 'clear',
  '/compact': 'compact',
  '/forget': 'forget',
}

const NOT_CONNECTED = 'Not connected -- your message was not sent. It is still here; try again in a moment.'

// ─── /memory and /system slash commands ────────────────────────────

interface MemorySlash {
  kind: 'memory_editor' | 'memory_refine' | 'system_editor'
  instruction?: string
  model?: string
}

const MODEL_BRACKET = /^\[([^\]]+)]\s*/

function parseMemorySlash(intent: string): MemorySlash | null {
  const lower = intent.toLowerCase()
  if (lower === '/system') return { kind: 'system_editor' }
  if (lower === '/memory') return { kind: 'memory_editor' }
  if (!lower.startsWith('/memory ')) return null
  let rest = intent.slice('/memory '.length).trim()
  let model: string | undefined
  const m = rest.match(MODEL_BRACKET)
  if (m) {
    model = m[1]
    rest = rest.slice(m[0].length).trim()
  }
  if (!rest) return { kind: 'memory_editor' }
  return { kind: 'memory_refine', instruction: rest, model }
}

type SetFn = (partial: Partial<DispatchState>) => void

async function fetchSotuDump(set: SetFn): Promise<void> {
  try {
    const res = await fetch('/api/sotu/fleet', { credentials: 'include' })
    if (!res.ok) {
      set({ lastError: `SotU fetch failed: ${res.status}` })
      return
    }
    set({ sotuDump: await res.json() })
  } catch (e) {
    set({ lastError: `SotU fetch failed: ${(e as Error).message}` })
  }
}

function handleMemorySlash(cmd: MemorySlash, set: SetFn): void {
  if (cmd.kind === 'memory_editor') {
    const requestId = nextRequestId()
    if (wsSend('dispatch_control', { action: 'memory_read', requestId })) {
      set({ intent: '', lastError: null })
    } else {
      set({ lastError: NOT_CONNECTED })
    }
    return
  }
  if (cmd.kind === 'system_editor') {
    const requestId = nextRequestId()
    if (wsSend('dispatch_control', { action: 'system_read', requestId })) {
      set({ intent: '', lastError: null })
    } else {
      set({ lastError: NOT_CONNECTED })
    }
    return
  }
  // memory_refine
  const requestId = nextRequestId()
  const payload: Record<string, unknown> = { action: 'memory_refine', requestId, instruction: cmd.instruction }
  if (cmd.model) payload.model = cmd.model
  if (wsSend('dispatch_control', payload)) {
    set({ intent: '', pending: true, lastError: null })
  } else {
    set({ lastError: NOT_CONNECTED })
  }
}

// The dispatcher is a single, per-user GLOBAL managed modal -- parkable + maximizable,
// folded into the same dock as THE DIALOGUE / Nightshift (see use-modal-manager).
const DISPATCH_MODAL = { id: 'dispatch', kind: 'dispatch', title: 'Dispatch' }

/**
 * Fire a `dispatch_request` and reflect the WIRE OUTCOME in store state.
 *
 * The anti-brick invariant (the voice "connected lied" lesson, 2026-06-24):
 * `pending` is ONLY ever cleared by an INBOUND reply (see dispatch-inbound), so we
 * must NOT enter `pending: true` unless the frame actually left the socket.
 * `wsSend` returns `false` and SILENTLY DROPS when the socket isn't OPEN -- doing
 * the optimistic `pending: true` anyway would wedge it forever (no reply ever
 * comes) and brick every future submit. That is the dead-input bug. On a drop we
 * surface `lastError` and stay fully recoverable. Returns whether it went out.
 */
function fireRequest(set: (partial: Partial<DispatchState>) => void, payload: Record<string, unknown>): boolean {
  const sent = wsSend('dispatch_request', payload)
  set(sent ? { pending: true, lastError: null } : { lastError: NOT_CONNECTED })
  return sent
}

export const useDispatchStore = create<DispatchState>((set, get) => ({
  open: false,
  userId: null,
  intent: '',
  history: null,
  decisions: [],
  activeTraceId: null,
  pending: false,
  lastError: null,
  roster: [],
  status: [],
  threadsLoading: false,
  activeConvId: null,
  rightPane: 'memory',
  model: DISPATCH_MODELS[0].slug,
  toolEvents: {},
  verbose: false,
  memory: '',
  workspaces: [],
  editorModal: null,
  refinePreview: null,
  sotuDump: null,

  // Enforce the `intent: string` invariant at the write boundary. CodeMirror's
  // onChange always hands us a string, but the `window.__dispatch` debug seam
  // (setIntent/submit) forwards untrusted args -- a `__dispatch.submit()` with
  // no argument would otherwise set intent=undefined and hard-crash the overlay
  // on the next `intent.trim()` (dispatch-intent-input + desk + memory section).
  setIntent: intent => set({ intent: intent ?? '' }),
  setModel: slug => set({ model: slug }),
  toggleVerbose: () => set(s => ({ verbose: !s.verbose })),

  submit: override => {
    try {
      // Guard the draft: a missing `intent` (e.g. an un-initialized store in a
      // stale bundle) must not throw on `.trim()` before we ever wsSend.
      const intent = (get().intent ?? '').trim()
      if (!intent || get().pending) return
      // Reset slash-commands (/clear /compact /forget) route to dispatch_control, not
      // the agent loop. Same anti-brick rule: only clear the draft if it left the wire.
      const action = SLASH_CONTROL[intent.toLowerCase()]
      if (action) {
        if (wsSend('dispatch_control', { action, requestId: nextRequestId() })) set({ intent: '', lastError: null })
        else set({ lastError: NOT_CONNECTED })
        return
      }
      // /sotu: open the SotU debug modal (REST fetch, not WS).
      if (intent.toLowerCase() === '/sotu') {
        set({ intent: '', lastError: null })
        fetchSotuDump(set)
        return
      }
      // /memory and /system: editor or refine, outside the agent loop.
      const memoryCmd = parseMemorySlash(intent)
      if (memoryCmd) {
        handleMemorySlash(memoryCmd, set)
        return
      }
      const requestId = nextRequestId()
      // Clear the draft ONLY once the frame is really on the wire ("on ask/Enter the
      // input must clear"). A dropped send keeps the user's text so they can retry --
      // clearing optimistically lost the message AND wedged the input (see fireRequest).
      if (fireRequest(set, { intent, requestId, model: get().model, ...override })) set({ intent: '' })
    } catch (err) {
      // Defect #2: never die silently before wsSend. Surface the throw as
      // lastError so a broken submit is visible instead of vanishing.
      set({ pending: false, lastError: err instanceof Error ? err.message : String(err) })
    }
  },

  confirmExpensive: decision => {
    fireRequest(set, {
      intent: decision.intent,
      requestId: nextRequestId(),
      target: decision.target,
      disposition: decision.disposition === 'ask' ? undefined : decision.disposition,
      confirmedExpensive: true,
    })
  },

  chooseCandidate: (candidate, ended) => {
    const intent = (get().intent ?? '').trim() || get().decisions[0]?.intent
    if (!intent) return
    fireRequest(set, {
      intent,
      requestId: nextRequestId(),
      target: candidate.conversationId,
      disposition: ended ? 'revive' : 'route',
    })
  },

  fetchThreads: () => {
    if (get().threadsLoading) return
    // Same anti-brick rule for the open-load: only enter the loading state if the
    // request truly left the socket. A dropped send leaves threadsLoading=false so
    // the reconnect effect (dispatch-overlay) re-fires it -- otherwise the overlay
    // wedges on "loading" forever and renders nothing (dead-on-open).
    if (wsSend('dispatch_list_threads', { requestId: nextRequestId() })) set({ threadsLoading: true })
  },

  openOverlay: () => {
    dispatchBus.open() // arm the lazy mount (first open fetches the chunk)
    set({ open: true })
    // Drive the global modal manager so the dispatcher opens as a parkable,
    // maximizable dock-managed panel (not a fullscreen trap). Restoring a parked
    // dispatcher re-opens it in place (global scope = no warp).
    useModalManagerStore.getState().open(DISPATCH_MODAL, { type: 'global' })
    get().fetchThreads()
  },
  closeOverlay: () => {
    set({ open: false })
    useModalManagerStore.getState().close('dispatch')
  },
  selectConv: id => set({ activeConvId: id, rightPane: id ? 'conversation' : 'memory' }),
  setRightPane: pane => set({ rightPane: pane }),
  routeTo: id => {
    useConversationsStore.getState().selectConversation(id, 'dispatch')
    get().closeOverlay()
  },

  // /memory + /system control results -- strategy map (STRATEGY MAPS covenant).
  onControlResult: msg => {
    const handlers: Record<string, () => void> = {
      memory_read: () => set({ editorModal: { kind: 'memory', content: msg.content ?? '' } }),
      system_read: () => set({ editorModal: { kind: 'system', content: msg.content ?? '' } }),
      memory_refine: () => {
        set({
          pending: false,
          refinePreview: msg.ok ? { before: msg.before ?? '', after: msg.after ?? '', model: msg.model ?? '' } : null,
        })
        if (!msg.ok) set({ lastError: msg.error ?? 'refine failed' })
      },
      memory_write: () => set({ editorModal: null }),
      system_write: () => set({ editorModal: null }),
    }
    const fn = msg.action ? handlers[msg.action] : undefined
    fn?.()
  },
  closeEditor: () => set({ editorModal: null }),
  saveEditor: content => {
    const modal = get().editorModal
    if (!modal) return
    const action = modal.kind === 'memory' ? 'memory_write' : 'system_write'
    wsSend('dispatch_control', { action, content, requestId: nextRequestId() })
    set({ editorModal: null })
  },
  confirmRefine: () => {
    const preview = get().refinePreview
    if (!preview) return
    wsSend('dispatch_control', { action: 'memory_write', content: preview.after, requestId: nextRequestId() })
    set({ refinePreview: null })
  },
  cancelRefine: () => set({ refinePreview: null }),
  closeSotu: () => set({ sotuDump: null }),

  // inbound WS reducers (history seed/stream, decision feed, tool gears)
  ...createInbound(set, get),
}))
