/**
 * WS message handlers for the dashboard.
 *
 * Each named function corresponds to one DashboardMessage `type`. Pulled out
 * of use-websocket.ts (was a 700-line switch in processMessage). The exported
 * `handlers` table is a Record<type, fn> consumed by the dispatcher.
 *
 * NOTE on Zustand stability: every state mutation here goes through
 * `useConversationsStore.setState` or `.getState()` -- never through a
 * subscribed selector -- so handler reorganization has no React #310 risk.
 */

import { applyPatch, type DeltaPatch } from '@shared/delta-sync'
import type { DialogOp, DialogSnapshot } from '@shared/dialog-live'
import type { DialogLayout } from '@shared/dialog-schema'
import { formatResetIn } from '@shared/format-reset-time'
import type { LaunchProfile } from '@shared/launch-profile'
import type {
  ConversationSummary,
  DispatchCandidate,
  DispatchDecision,
  DispatchHistoryDump,
  DispatchThread,
  DispatchToolCall,
  DispatchToolResult,
  RecapCompleteMessage,
  RecapCreatedMessage,
  RecapErrorMessage,
  RecapPeriodLabel,
  RecapProgressMessage,
  RecapRegeneratedMessage,
  RecapSummary,
  ShellRosterEntry,
} from '@shared/protocol'
import { useDispatchStore } from '@/components/dispatch-overlay/dispatch-store'
import { handleLaunchProfilesUpdatedMessage } from '@/components/launch-profiles/use-launch-profiles'
import { daemonControlToast } from '@/lib/daemon-control'
import { record } from '@/lib/perf-metrics'
import { forgetFull, rememberFull, slimConversation } from '@/lib/slim-conversation'
import { cachePushEntries } from '@/lib/transcript-page-cache'
import type {
  ClaudeEfficiencyUpdate,
  ClaudeHealthUpdate,
  Conversation,
  ProjectOrder,
  TaskInfo,
  TranscriptEntry,
} from '@/lib/types'
import { setLastConversationId } from '@/lib/ui-state'
import { formatRateBucketName, haptic } from '@/lib/utils'
import { clearAuthNeeded, setAuthNeeded } from './auth-needed-store'
import { addDebugTraceEvent, setDebugTraceResult } from './debug-control-store'
import { clearThinkingProgress, recordThinkingProgress } from './thinking-progress-store'
import { recordTokenSample } from './token-flow-store'
import {
  applyHashRoute,
  dropConversationPatch,
  fetchTranscript,
  type ProjectSettingsMap,
  updateHash,
  useConversationsStore,
} from './use-conversations'
import { useLiveDialogsStore } from './use-live-dialogs'
import { useRecapJobsStore } from './use-recap-jobs'
import { useShellsStore } from './use-shells'
import { handleSpawnRequestAck } from './use-spawn'

// Loose WS message type (mirror of use-websocket.ts -- intentionally duplicated
// to keep this module standalone; the canonical source lives in use-websocket.ts).
export interface DashboardMessage {
  type: string
  conversationId?: string
  previousConversationId?: string
  conversation?: ConversationSummary
  conversations?: ConversationSummary[]
  // biome-ignore lint/suspicious/noExplicitAny: pass-through for unknown server fields
  [key: string]: any
}

// ─── stream-delta batching (W-H2) ───────────────────────────────────────────
// Token deltas used to write Zustand on EVERY token: an object spread (per
// buffer) plus a full store notify, for each token. With several conversations
// streaming at ~20 tok/s that is a torrent of short-lived allocations and
// subscriber notifications -- the dominant streaming GC churn. We now
// accumulate deltas in a module-level buffer and flush to the store once per
// animation frame (a 100ms timer is the fallback for when the tab is hidden and
// rAF is suspended), coalescing every pending token across every conversation
// into a single store write. Force-flushed on message_stop so the final text is
// never late, and drained whenever a committed entry supersedes the buffer.
type PendingStreamDelta = { text: string; thinking: string }
const pendingStreamDeltas = new Map<string, PendingStreamDelta>()
let streamFlushRaf: number | null = null
let streamFlushTimer: ReturnType<typeof setTimeout> | null = null

function scheduleStreamFlush() {
  if (streamFlushRaf !== null || streamFlushTimer !== null) return
  // rAF aligns the flush with paint when the tab is visible; the timer is the
  // fallback for the hidden-tab case where rAF is suspended. Whichever fires
  // first runs flushStreamDeltas, which cancels the other.
  if (typeof requestAnimationFrame === 'function') {
    streamFlushRaf = requestAnimationFrame(flushStreamDeltas)
  }
  streamFlushTimer = setTimeout(flushStreamDeltas, 100)
}

/**
 * Drain the pending stream-delta buffer into Zustand in ONE setState: append
 * each conversation's buffered text/thinking onto its committed streaming
 * buffer, cloning a buffer object only if it actually changed, and bump
 * `newDataSeq` once if any conversation crossed a 500-char boundary (the
 * auto-scroll nudge). Exported so tests can flush deterministically.
 */
export function flushStreamDeltas() {
  if (streamFlushRaf !== null) {
    cancelAnimationFrame(streamFlushRaf)
    streamFlushRaf = null
  }
  if (streamFlushTimer !== null) {
    clearTimeout(streamFlushTimer)
    streamFlushTimer = null
  }
  if (pendingStreamDeltas.size === 0) return
  const entries = [...pendingStreamDeltas.entries()]
  pendingStreamDeltas.clear()
  useConversationsStore.setState(state => {
    let streamingText = state.streamingText
    let streamingThinking = state.streamingThinking
    let textCloned = false
    let thinkingCloned = false
    let bumpScroll = false
    for (const [sid, pend] of entries) {
      if (pend.text) {
        const prev = streamingText[sid] || ''
        const updated = prev + pend.text
        if (Math.floor(updated.length / 500) > Math.floor(prev.length / 500)) bumpScroll = true
        if (!textCloned) {
          streamingText = { ...streamingText }
          textCloned = true
        }
        streamingText[sid] = updated
      }
      if (pend.thinking) {
        const prev = streamingThinking[sid] || ''
        const updated = prev + pend.thinking
        if (Math.floor(updated.length / 500) > Math.floor(prev.length / 500)) bumpScroll = true
        if (!thinkingCloned) {
          streamingThinking = { ...streamingThinking }
          thinkingCloned = true
        }
        streamingThinking[sid] = updated
      }
    }
    if (!(textCloned || thinkingCloned || bumpScroll)) return state
    const patch: Partial<typeof state> = {}
    if (textCloned) patch.streamingText = streamingText
    if (thinkingCloned) patch.streamingThinking = streamingThinking
    if (bumpScroll) patch.newDataSeq = state.newDataSeq + 1
    return patch
  })
}

function bufferStreamDelta(sid: string, text: string, thinking: string) {
  const pend = pendingStreamDeltas.get(sid)
  if (pend) {
    pend.text += text
    pend.thinking += thinking
  } else {
    pendingStreamDeltas.set(sid, { text, thinking })
  }
  scheduleStreamFlush()
}

/** Task-roster fields with their empty-state fallbacks, lifted out of
 *  toConversation to keep that mapper under the complexity bar. */
function toTaskFields(summary: ConversationSummary) {
  return {
    taskCount: summary.taskCount ?? 0,
    pendingTaskCount: summary.pendingTaskCount ?? 0,
    activeTasks: summary.activeTasks ?? [],
    pendingTasks: summary.pendingTasks ?? [],
    completedTaskCount: summary.completedTaskCount ?? 0,
    completedTasks: summary.completedTasks ?? [],
    archivedTaskCount: summary.archivedTaskCount ?? 0,
    archivedTasks: summary.archivedTasks ?? [],
  }
}

function toConversation(summary: ConversationSummary): Conversation {
  return {
    id: summary.id,
    project: summary.project,
    model: summary.model,
    capabilities: summary.capabilities,
    connectionIds: summary.connectionIds,
    startedAt: summary.startedAt,
    lastActivity: summary.lastActivity,
    status: summary.status,
    compacting: summary.compacting,
    compactedAt: summary.compactedAt,
    eventCount: summary.eventCount,
    activeSubagentCount: summary.activeSubagentCount ?? 0,
    totalSubagentCount: summary.totalSubagentCount ?? 0,
    subagents: summary.subagents ?? [],
    ...toTaskFields(summary),
    runningBgTaskCount: summary.runningBgTaskCount ?? 0,
    bgTasks: summary.bgTasks ?? [],
    monitors: summary.monitors ?? [],
    runningMonitorCount: summary.runningMonitorCount ?? 0,
    teammates: summary.teammates ?? [],
    team: summary.team,
    effortLevel: summary.effortLevel,
    permissionMode: summary.permissionMode,
    lastError: summary.lastError,
    rateLimit: summary.rateLimit,
    planMode: summary.planMode,
    pendingAttention: summary.pendingAttention,
    // THE STATUS: the agent's self-reported set_status slot drives the per-
    // conversation attention badge (StatusBadge). Easy to miss in this explicit
    // whitelist -- omitting it silently drops the field client-side so the card
    // badge never renders even though the broker serializes + broadcasts it.
    liveStatus: summary.liveStatus,
    lastInputAt: summary.lastInputAt,
    pendingSpawnApproval: summary.pendingSpawnApproval,
    spawnAutoApproved: summary.spawnAutoApproved,
    hasNotification: summary.hasNotification,
    summary: summary.summary,
    title: summary.title,
    description: summary.description,
    agentName: summary.agentName,
    prLinks: summary.prLinks,
    linkedProjects: summary.linkedProjects,
    linkedConversations: summary.linkedConversations,
    tokenUsage: summary.tokenUsage,
    contextWindow: summary.contextWindow,
    cacheTtl: summary.cacheTtl,
    lastTurnEndedAt: summary.lastTurnEndedAt,
    stats: summary.stats,
    costTimeline: summary.costTimeline,
    gitBranch: summary.gitBranch,
    adHocTaskId: summary.adHocTaskId,
    adHocWorktree: summary.adHocWorktree,
    resultText: summary.resultText,
    recap: summary.recap,
    recapFresh: summary.recapFresh,
    hostSentinelId: summary.hostSentinelId,
    hostSentinelAlias: summary.hostSentinelAlias,
    shellCapable: summary.shellCapable,
    resolvedProfile: summary.resolvedProfile,
    version: summary.version,
    buildTime: summary.buildTime,
    claudeVersion: summary.claudeVersion,
    claudeAuth: summary.claudeAuth,
    spinnerVerbs: summary.spinnerVerbs,
    autocompactPct: summary.autocompactPct,
    backend: summary.backend,
    // Resolved transport ('claude-pty' | 'claude-headless' | 'claude-daemon').
    // Serialized by the broker (conversation-store toConversationSummary) but was
    // dropped from this whitelist -- so transport was always undefined client-side
    // (the silent-drop bug the liveStatus note above warns about). The Login
    // palette command + any transport-gated UI need it.
    transport: summary.transport,
    // Spawn lineage (Phase 3 carries parent/root over WS; directChildCount is
    // REST-only, so it stays undefined here and the UI walks the local list).
    parentConversationId: summary.parentConversationId,
    rootConversationId: summary.rootConversationId,
    // Night-task origin tag (drives the live Status screen's per-task rows).
    nightshift: summary.nightshift,
  }
}

// ─── sync protocol ─────────────────────────────────────────────────────────

function handleSyncOk(msg: DashboardMessage) {
  const ok = msg as DashboardMessage & { epoch?: string; seq?: number }
  const stale = (msg as DashboardMessage & { staleTranscripts?: Record<string, number> }).staleTranscripts
  const staleInfo = stale ? ` staleTranscripts=${Object.keys(stale).length}` : ''
  console.log(`[sync] <- sync_ok (epoch=${ok.epoch?.slice(0, 8)} seq=${ok.seq})${staleInfo}`)
}

function handleSyncCatchup(msg: DashboardMessage) {
  const cu = msg as DashboardMessage & { count?: number; epoch?: string; seq?: number }
  const stale = (msg as DashboardMessage & { staleTranscripts?: Record<string, number> }).staleTranscripts
  const staleInfo = stale ? ` staleTranscripts=${Object.keys(stale).length}` : ''
  console.log(`[sync] <- sync_catchup: ${cu.count} missed (epoch=${cu.epoch?.slice(0, 8)} seq=${cu.seq})${staleInfo}`)
}

let lastSyncStaleBumpAt = 0
const SYNC_STALE_DEBOUNCE_MS = 2_000

function handleSyncStale(msg: DashboardMessage) {
  const stale = msg as DashboardMessage & { reason?: string; missed?: number; epoch?: string; seq?: number }
  const staleTranscripts = (msg as DashboardMessage & { staleTranscripts?: Record<string, number> }).staleTranscripts
  const staleInfo = staleTranscripts ? ` staleTranscripts=${Object.keys(staleTranscripts).length}` : ''

  // Coalesce rapid-fire sync_stale messages (tab-restore storm): only the
  // first bump within SYNC_STALE_DEBOUNCE_MS triggers the full reconnect
  // cycle (refresh_sessions + fetchSidebarMetadata + fetchConversationData).
  // Later arrivals still update epoch/seq but skip the connectSeq bump that
  // fires the expensive useConnectSeqSync effect.
  const now = performance.now()
  const shouldBump = now - lastSyncStaleBumpAt > SYNC_STALE_DEBOUNCE_MS
  if (shouldBump) lastSyncStaleBumpAt = now

  console.log(
    `[sync] <- sync_stale: ${stale.reason || 'unknown'} missed=${stale.missed || '?'}${staleInfo}${shouldBump ? '' : ' (debounced)'}`,
  )

  useConversationsStore.setState(s => ({
    ...(shouldBump ? { connectSeq: s.connectSeq + 1 } : {}),
    syncEpoch: stale.epoch || '',
    syncSeq: stale.seq || 0,
    lastAppliedTranscriptSeq: {},
  }))
}

// ─── conversation lifecycle ────────────────────────────────────────────────

function handleConversationsList(msg: DashboardMessage) {
  if (msg.conversations) {
    useConversationsStore.getState().setConversations(msg.conversations.map(toConversation))
    applyHashRoute()
  }
  // Version mismatch detection removed -- SW lifecycle handles update detection.
  // When sw.js changes, browser installs new SW and sends 'sw-updated' postMessage.
}

function handleConversationCreated(msg: DashboardMessage) {
  if (!msg.conversation) return
  const fullConversation = toConversation(msg.conversation)
  useConversationsStore.setState(state => {
    const id = fullConversation.id
    rememberFull(fullConversation, state.selectedConversationId)
    // Source of truth is the index; upsert ONE key. Selected stays full, others
    // slim (residency invariant). Merge over any prior placeholder entry.
    const isSelected = state.selectedConversationId === id
    const entry = isSelected ? fullConversation : slimConversation(fullConversation)
    const prev = state.conversationsById[id]
    return {
      conversationsById: { ...state.conversationsById, [id]: prev ? { ...prev, ...entry } : entry },
    }
  })
}

type ConversationsState = ReturnType<typeof useConversationsStore.getState>

/**
 * Selection is following a rekey -- the conversation the user is viewing got a
 * new id. Mirror ONLY the bookkeeping a rekey genuinely needs: swap the
 * selection to the new id, swap the MRU entry so the dead placeholder id doesn't
 * linger, and migrate any locally-cached events/transcripts from the placeholder
 * id to the real id. Deliberately NOT selectConversation -- that carries switch
 * semantics (closing the terminal, clearing expanded state, firing
 * conversation_viewed) that are all wrong for a same-conversation rekey. The
 * hash + last-viewed pointer are handled by the caller after the reducer.
 * Mutates `newState`.
 */
function applyRekeyFollow(
  state: ConversationsState,
  prevId: string,
  conversationId: string,
  newState: Partial<ConversationsState>,
): void {
  newState.selectedConversationId = conversationId
  newState.conversationMru = state.conversationMru
    .map(x => (x === prevId ? conversationId : x))
    .filter((x, i, arr) => arr.indexOf(x) === i)
  const oldEvents = state.events[prevId]
  const oldTranscripts = state.transcripts[prevId]
  if (!oldEvents && !oldTranscripts) return
  const events = { ...state.events }
  const transcripts = { ...state.transcripts }
  delete events[prevId]
  delete transcripts[prevId]
  // Preserve any data already received for the new conversation ID
  // (e.g. compacting marker broadcast during rekey)
  if (!events[conversationId]) events[conversationId] = []
  if (!transcripts[conversationId]) transcripts[conversationId] = []
  newState.events = events
  newState.transcripts = transcripts
}

/** True when the conversation the user is currently viewing is the one being
 *  rekeyed -- captured BEFORE the reducer swaps the selection. */
function selectionFollowsRekey(prevId: string | undefined, conversationId: string): boolean {
  return !!prevId && prevId !== conversationId && useConversationsStore.getState().selectedConversationId === prevId
}

/** Keep the URL hash and last-viewed pointer in sync after selection followed a
 *  rekey (side-effects, so they run outside the reducer). Without this the hash
 *  still points at the dead placeholder id and a reload would try to select a
 *  conversation that no longer exists. No-op when the rekey wasn't followed. */
function syncNavPointersAfterRekey(followed: boolean, conversationId: string): void {
  if (!followed) return
  updateHash(`conversation/${conversationId}`)
  setLastConversationId(conversationId)
}

function handleConversationUpdate(msg: DashboardMessage) {
  if (!(msg.conversation && msg.conversationId)) return
  const conversationId = msg.conversationId
  const conversation = msg.conversation
  const prevId = msg.previousConversationId
  const matchId = prevId || conversationId
  // Is the conversation the user is currently viewing the one being rekeyed?
  // If so, selection follows the id swap (applyRekeyFollow, in the reducer) and
  // the hash + last-viewed pointer are remapped after the reducer.
  const followedRekey = selectionFollowsRekey(prevId, conversationId)
  useConversationsStore.setState(state => {
    const updated = toConversation(conversation)
    // W-H3: conversationsById is the source of truth -- patch ONE key instead of
    // rebuilding a parallel array on every fleet message. The map upsert also makes
    // the rekey-collision dedupe FREE: two booting placeholders rekeying to the same
    // real id can never coexist (the second write overwrites the first key), so the
    // sidebar never shows ghost rows. The `{ ...prev, ...updated }` merge (slim/full
    // base + full update) yields the new full payload; remember it in the side-map,
    // then slim it for non-selected list residency.
    const selectedId = state.selectedConversationId
    // On rekey, the old prevId full payload in the side-map is now orphaned.
    if (prevId && prevId !== conversationId) forgetFull(prevId)
    const prev = state.conversationsById[matchId]
    const merged = prev ? { ...prev, ...updated } : updated
    rememberFull(merged, selectedId)
    // Keep the OPEN conversation full (others slim). `matchId` covers a rekey of
    // the selected conversation (selectedId === prevId) so it doesn't flash slim
    // mid-rekey; the normal case is selectedId === conversationId === matchId.
    const entry = selectedId === conversationId || selectedId === matchId ? merged : slimConversation(merged)
    let conversationsById: Record<string, Conversation>
    if (prevId && prevId !== conversationId) {
      // Rekey: drop the old placeholder key, upsert under the real id.
      const { [prevId]: _old, [conversationId]: _existing, ...rest } = state.conversationsById
      conversationsById = { ...rest, [conversationId]: entry }
    } else {
      conversationsById = { ...state.conversationsById, [conversationId]: entry }
    }
    const newState: Partial<typeof state> = { conversationsById }
    // Clear stale streaming buffers when conversation goes idle or ends. Both
    // text AND thinking are transient in-flight indicators -- the committed
    // transcript entries carry the real thinking + text blocks (see
    // parse-entries.ts / ThinkingItem), so there is nothing to preserve here.
    if (updated.status === 'idle' || updated.status === 'ended') {
      if (state.streamingText[conversationId]) {
        const { [conversationId]: _t, ...rest } = state.streamingText
        newState.streamingText = rest
      }
      if (state.streamingThinking[conversationId]) {
        const { [conversationId]: _k, ...rest } = state.streamingThinking
        newState.streamingThinking = rest
      }
    }
    if (prevId && state.selectedConversationId === prevId) {
      console.log(
        `[nav] conversation rekey: ${prevId.slice(0, 8)} -> ${conversationId.slice(0, 8)} (selected conversation rekeyed)`,
      )
      applyRekeyFollow(state, prevId, conversationId, newState)
    }
    return newState
  })
  syncNavPointersAfterRekey(followedRekey, conversationId)
  // Rekey: transcript moved from old-id to new-id locally, but we may have
  // missed channel entries under new-id while backgrounded. Re-fetch.
  if (prevId) {
    console.log(
      `[sync] session_update: REKEY ${prevId.slice(0, 8)} -> ${conversationId.slice(0, 8)} status=${conversation.status}`,
    )
    // Delay: broker processes rekey and re-receives transcript from rclaude.
    // 500ms gives the transcript watcher time to stream initial entries to the new ID.
    setTimeout(() => {
      fetchTranscript(conversationId).then(transcript => {
        console.log(
          `[sync] rekey refetch ${conversationId.slice(0, 8)}: ${transcript?.entries.length ?? 'null'} entries lastSeq=${transcript?.lastSeq ?? '-'}`,
        )
        if (transcript) useConversationsStore.getState().setTranscript(conversationId, transcript.entries)
      })
    }, 500)
  } else if (conversation.status === 'starting') {
    const state = useConversationsStore.getState()
    const cached = state.transcripts[conversationId]?.length ?? 0
    const isSelected = state.selectedConversationId === conversationId
    console.log(`[sync] session_update: RESUME ${conversationId.slice(0, 8)} selected=${isSelected} cached=${cached}`)
    if (isSelected) {
      // Always refetch on resume -- transcript may have been corrupted by a
      // same-ID rekey or the conversation may have new data from a restart.
      setTimeout(() => {
        fetchTranscript(conversationId).then(transcript => {
          console.log(
            `[sync] resume refetch ${conversationId.slice(0, 8)}: ${transcript?.entries.length ?? 'null'} entries lastSeq=${transcript?.lastSeq ?? '-'}`,
          )
          if (transcript) useConversationsStore.getState().setTranscript(conversationId, transcript.entries)
        })
      }, 1000)
    }
  }
}

function handleConversationPatch(msg: DashboardMessage) {
  const conversationId = msg.conversationId
  const diffs = msg.diffs as DeltaPatch | undefined
  if (!conversationId || !diffs || diffs.length === 0) return

  useConversationsStore.setState(state => {
    const prev = state.conversationsById[conversationId]
    if (!prev) return state
    const patched = applyPatch(prev, diffs) as Conversation
    const selectedId = state.selectedConversationId
    rememberFull(patched, selectedId)
    const entry = selectedId === conversationId ? patched : slimConversation(patched)
    const newState: Partial<typeof state> = {
      conversationsById: { ...state.conversationsById, [conversationId]: entry },
    }
    if (patched.status === 'idle' || patched.status === 'ended') {
      if (state.streamingText[conversationId]) {
        const { [conversationId]: _t, ...rest } = state.streamingText
        newState.streamingText = rest
      }
      if (state.streamingThinking[conversationId]) {
        const { [conversationId]: _k, ...rest } = state.streamingThinking
        newState.streamingThinking = rest
      }
    }
    return newState
  })
}

function handleChannelAck(msg: DashboardMessage) {
  // Channel subscription acknowledgment - log for debugging
  const ack = msg as DashboardMessage & { channel?: string; previousConversationId?: string }
  if (ack.previousConversationId) {
    console.log(
      `[ws] Channel ${ack.channel} rolled over: ${ack.previousConversationId.slice(0, 8)} -> ${ack.conversationId?.slice(0, 8)}`,
    )
  }
}

const EVENTS_CAP = 500

function handleEvent(msg: DashboardMessage) {
  if (!(msg.event && msg.conversationId)) return
  const sid = msg.conversationId
  const evt = msg.event
  useConversationsStore.setState(state => {
    const currentEvents = state.events[sid] || []
    const next = [...currentEvents, evt]
    return {
      events: {
        ...state.events,
        [sid]: next.length > EVENTS_CAP ? next.slice(-EVENTS_CAP) : next,
      },
    }
  })
}

// ─── transcripts + streaming ───────────────────────────────────────────────

/** Live-state cap. Tail-grow paths (incremental WS broadcast, delta refetch)
 *  prune the HEAD of the in-memory transcript when it exceeds this. Evicted
 *  entries flow into the transcript page cache so a scroll-up doesn't round
 *  -trip the broker for entries the client just saw. PASSIVE: only triggered
 *  by a live append, never by a prepend or by returning to the bottom. See
 *  .claude/docs/plan-progressive-transcript-impl.md for the design. */
const TRANSCRIPT_LIVE_CAP = 100

function handleTranscriptEntries(msg: DashboardMessage) {
  if (!msg.conversationId || !msg.entries) return
  const sid = msg.conversationId
  const newEntries = msg.entries as TranscriptEntry[]
  const initial = msg.isInitial as boolean
  // Terminus for the live thinking indicator: any new (non-initial) entry
  // means the model has emitted SOMETHING -- the thinking phase is over.
  // Cheap insurance even though the store has its own 4s staleness clear.
  if (!initial && newEntries.length > 0) {
    clearThinkingProgress(sid)
    // A fresh entry means the model produced output -> auth recovered (the
    // stalled 401 turn self-healed, or an external re-login landed). Clear the
    // re-login hint so it never lingers stale.
    clearAuthNeeded(sid)
  }
  useConversationsStore.setState(state => {
    const existing = state.transcripts[sid] || []
    // isInitial=true REPLACES the cache. The agent host fires this on WS
    // reconnect (resendTranscriptFromFile in headless) and on PTY
    // truncation. If the snapshot is SMALLER than what we already have
    // AND the first entry matches, the snapshot was taken before CC
    // flushed the newest entries -- swallowing the replace would wipe
    // live entries the client already displayed. Skip in that case
    // (mirrors setTranscript's guard). When first entries differ
    // (e.g. /clear created a new conversation, or compaction rewrote
    // the prefix) the replace is legitimate -- proceed.
    let result: TranscriptEntry[]
    let skipped = false
    if (initial && existing.length > newEntries.length && existing.length > 0 && newEntries.length > 0) {
      const fp = (e: TranscriptEntry) => {
        const m = (e as { message?: { content?: unknown } }).message
        const c = m?.content
        return JSON.stringify(c ?? e.type)?.slice(0, 100)
      }
      if (fp(existing[0]) === fp(newEntries[0])) {
        result = existing
        skipped = true
      } else {
        result = newEntries
      }
    } else if (initial) {
      result = newEntries
    } else {
      // Incremental append -- dedup by seq against our last-applied.
      // Guards the race where a sync_check delta fetch raced with a live
      // WS broadcast and we applied the delta first. Without this guard,
      // the broadcast would re-append entries we already have.
      const localMax = state.lastAppliedTranscriptSeq[sid] ?? 0
      const fresh = newEntries.filter(e => e.seq === undefined || e.seq > localMax)
      if (fresh.length === 0) {
        return {}
      }
      result = [...existing, ...fresh]
      // Passive prune: tail grew, head may now exceed the live cap. Evicted
      // entries are pushed into the page cache so a scroll-up after the
      // prune can replay them locally without a broker round-trip. Skipped
      // on the initial-replace path -- that's a server-determined snapshot,
      // not a live tail-grow. ALSO skipped while the user is in scrollback
      // (follow=false mirrored into state.scrollbackActive[sid]): pruning
      // the head while the user is reading prepended-older history would
      // yank entries out from under their viewport. Deferred-collapse runs
      // on return-to-bottom via setScrollbackActive(sid, false).
      const scrollback = state.scrollbackActive[sid]
      if (result.length > TRANSCRIPT_LIVE_CAP && scrollback) {
        console.debug(
          `[transcript-prune] ${sid.slice(0, 8)} DEFERRED (scrollback active): live=${result.length} > cap ${TRANSCRIPT_LIVE_CAP}, collapse on return-to-bottom`,
        )
      }
      if (result.length > TRANSCRIPT_LIVE_CAP && !scrollback) {
        const t0 = performance.now()
        const dropCount = result.length - TRANSCRIPT_LIVE_CAP
        const evicted = result.slice(0, dropCount)
        result = result.slice(dropCount)
        cachePushEntries(sid, evicted)
        const elapsed = performance.now() - t0
        record(
          'transcript',
          'prune',
          elapsed,
          `${sid.slice(0, 8)} -${dropCount} (seq ${evicted[0]?.seq}..${evicted[evicted.length - 1]?.seq}) -> cache; live=${result.length}`,
        )
        console.debug(
          `[transcript-prune] ${sid.slice(0, 8)} dropped ${dropCount} entries (seq ${evicted[0]?.seq}..${evicted[evicted.length - 1]?.seq}) to cache; live=${result.length} (cap ${TRANSCRIPT_LIVE_CAP}, ${elapsed.toFixed(1)}ms)`,
        )
      }
    }
    if (initial || newEntries.length > 2) {
      console.log(
        `[ws] transcript ${sid.slice(0, 8)}: +${newEntries.length} ${initial ? (skipped ? 'INITIAL-SKIP' : 'INITIAL') : 'incremental'} (total=${result.length})`,
      )
    }
    // Clear BOTH streaming buffers when a committed assistant entry arrives.
    // This is the primary, seamless swap point: the committed transcript entry
    // contains the real thinking + text blocks (parse-entries.ts builds
    // `thinking` RenderItems incl. the encrypted case; GroupView renders them
    // via ThinkingItem in correct chronological order, gated by showThinking).
    // The streaming buffers are PURELY transient in-flight indicators. Keeping
    // the thinking buffer alive past commit was the root cause of the duplicate
    // thinking block + the delayed-shrink jerk -- the committed entry already
    // shows the thinking, so the buffer is redundant the instant it lands.
    const hasAssistant = newEntries.some(e => e.type === 'assistant')
    let streamingText = state.streamingText
    let streamingThinking = state.streamingThinking
    if (hasAssistant) {
      // The committed entry supersedes the buffer -- drop any not-yet-flushed
      // deltas so a scheduled flush can't repopulate the buffers we just cleared
      // (orphan streaming bubble below the committed text).
      pendingStreamDeltas.delete(sid)
      if (streamingText[sid]) {
        const { [sid]: _t, ...rest } = streamingText
        streamingText = rest
      }
      if (streamingThinking[sid]) {
        const { [sid]: _k, ...rest } = streamingThinking
        streamingThinking = rest
      }
    }
    // Update lastAppliedTranscriptSeq. For isInitial, ALWAYS take the snapshot's
    // max seq (even when skipped) so a broker restart that resets the counter
    // doesn't leave a stale high-water mark that filters all future entries.
    const maxSeqInResult = result.length > 0 ? (result[result.length - 1].seq ?? 0) : 0
    const prevSeq = state.lastAppliedTranscriptSeq[sid] ?? 0
    const newSeq = initial ? maxSeqInResult : Math.max(prevSeq, maxSeqInResult)
    return {
      transcripts: {
        ...state.transcripts,
        [sid]: result,
      },
      lastAppliedTranscriptSeq:
        newSeq !== prevSeq ? { ...state.lastAppliedTranscriptSeq, [sid]: newSeq } : state.lastAppliedTranscriptSeq,
      streamingText,
      streamingThinking,
      newDataSeq: state.newDataSeq + 1,
    }
  })
}

function handleConversationInfo(msg: DashboardMessage) {
  // Conversation metadata from headless init - store for autocomplete
  const sid = msg.conversationId as string
  if (!sid) return
  useConversationsStore.setState(state => ({
    conversationInfo: {
      ...state.conversationInfo,
      [sid]: {
        tools: (msg.tools as string[]) || [],
        slashCommands: (msg.slashCommands as string[]) || [],
        skills: (msg.skills as string[]) || [],
        agents: (msg.agents as string[]) || [],
        mcpServers: (msg.mcpServers as Array<{ name: string; status?: string }>) || [],
        model: (msg.model as string) || '',
        permissionMode: (msg.permissionMode as string) || '',
        claudeCodeVersion: (msg.claudeCodeVersion as string) || '',
      },
    },
  }))
  console.log(
    `[ws] conversation_info ${sid.slice(0, 8)}: ${(msg.tools as unknown[])?.length} tools, ${(msg.skills as unknown[])?.length} skills`,
  )
}

function handleStreamDelta(msg: DashboardMessage) {
  // Token streaming -- accumulate text + thinking deltas. Sources today:
  // headless CC `--include-partial-messages`, chat-api SSE, ACP agent host.
  const sid = msg.conversationId as string
  const event = msg.event as Record<string, unknown> | undefined
  if (!(sid && event)) return
  const eventType = event.type as string
  if (eventType === 'content_block_delta') {
    // Drop stale content deltas: a delta for a non-active conversation is a
    // late tail arriving after the turn already committed. Classic on cold
    // load -- the isInitial HTTP snapshot already carries the committed
    // assistant entry (which clears the buffer), then a trailing live delta
    // repopulates streamingText with no further committed entry coming to
    // clear it, leaving an orphaned duplicate bubble below the final text.
    // Only an ACTIVE turn grows the buffer -- the same 'active' signal the
    // thinking cursor + verb spinner already gate on (in-flight-decorations).
    // message_start / message_stop are NOT gated below: they reset/clear the
    // buffer and must run regardless of status.
    if (useConversationsStore.getState().conversationsById[sid]?.status !== 'active') return
    const delta = event.delta as Record<string, unknown> | undefined
    // Buffer the delta -- the actual store write is coalesced in flushStreamDeltas.
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      bufferStreamDelta(sid, delta.text as string, '')
    } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      bufferStreamDelta(sid, '', delta.thinking as string)
    }
  } else if (eventType === 'message_start') {
    // New message -- reset BOTH streaming buffers for a clean slate. Do NOT
    // reset on content_block_start: a single assistant message can have
    // multiple blocks (interleaved tool_use / thinking / text) and resetting
    // on each block wipes earlier deltas before the committed entry lands.
    // Resetting per-message is correct: the prior message's content has
    // already committed (and cleared these buffers) by the time the next
    // message_start fires. Drop buffered deltas too so a late flush can't
    // repopulate the fresh buffer (W-L5: bounds streamingThinking retention to
    // a single turn).
    pendingStreamDeltas.delete(sid)
    useConversationsStore.setState(state => {
      const next: Partial<typeof state> = {}
      if (state.streamingText[sid]) next.streamingText = { ...state.streamingText, [sid]: '' }
      if (state.streamingThinking[sid]) next.streamingThinking = { ...state.streamingThinking, [sid]: '' }
      return next
    })
  } else if (eventType === 'message_stop') {
    // Turn complete -- force-flush buffered deltas so the final text/thinking is
    // never late, then clear streaming TEXT (committed entry replaces it).
    // flushStreamDeltas drains the pending buffer, so no scheduled flush can
    // repopulate streamingText after the clear (orphan-bubble race). Keep
    // streaming THINKING: committed entries don't contain thinking blocks, so
    // this is the only copy until message_start resets it or a committed entry
    // / conversation switch clears it.
    flushStreamDeltas()
    useConversationsStore.setState(state => {
      const hasText = !!state.streamingText[sid]
      if (!hasText) return state
      const { [sid]: _, ...rest } = state.streamingText
      return { streamingText: rest }
    })
  }
}

function handleSubagentTranscript(msg: DashboardMessage) {
  if (!msg.conversationId || !msg.entries) return
  const subMsg = msg as DashboardMessage & { agentId?: string }
  const agentId = subMsg.agentId
  if (!agentId) return
  const sid = msg.conversationId
  const newEntries = msg.entries as TranscriptEntry[]
  const initial = msg.isInitial as boolean
  const key = `${sid}:${agentId}`
  useConversationsStore.setState(state => {
    const existing = state.subagentTranscripts[key] || []
    const merged = initial ? newEntries : [...existing, ...newEntries]
    return {
      subagentTranscripts: {
        ...state.subagentTranscripts,
        [key]: merged.length > TRANSCRIPT_LIVE_CAP ? merged.slice(-TRANSCRIPT_LIVE_CAP) : merged,
      },
    }
  })
}

// ─── tasks / sentinel / settings ───────────────────────────────────────────

function handleTasksUpdate(msg: DashboardMessage) {
  if (!(msg.conversationId && msg.tasks)) return
  const sid = msg.conversationId
  const taskList = msg.tasks as TaskInfo[]
  useConversationsStore.setState(state => ({
    tasks: { ...state.tasks, [sid]: taskList },
  }))
}

function handleSentinelStatus(msg: DashboardMessage) {
  if (msg.connected !== undefined) {
    useConversationsStore.getState().setSentinelConnected(msg.connected, msg.sentinels)
  }
}

/**
 * `daemon_roster` -- a sentinel's live daemon worker roster, forwarded by the
 * broker (ccSessionId stripped). Stored per sentinel; drives the spawn dialog's
 * ATTACH mode roster browser via use-daemon-roster.
 */
function handleDaemonRoster(msg: DashboardMessage) {
  if (!Array.isArray(msg.jobs)) return
  useConversationsStore.getState().setDaemonRoster({
    type: 'daemon_roster',
    sentinelId: typeof msg.sentinelId === 'string' ? msg.sentinelId : undefined,
    sentinelAlias: typeof msg.sentinelAlias === 'string' ? msg.sentinelAlias : undefined,
    daemonPresent: msg.daemonPresent === true,
    daemonProto: typeof msg.daemonProto === 'number' ? msg.daemonProto : undefined,
    jobs: msg.jobs,
    observedAt: typeof msg.observedAt === 'number' ? msg.observedAt : Date.now(),
  })
}

/**
 * `daemon_control_result` -- the outcome of a daemon remote-control op
 * (reply / kill / respawn-stale / permission-response), forwarded by the
 * broker. Surfaced as a toast so every control verb the user fired resolves
 * visibly (EVERYTHING IS A STRUCTURED MESSAGE). A successful `reply` is
 * intentionally quiet -- the transcript already shows it.
 */
function handleDaemonControlResult(msg: DashboardMessage) {
  const toast = daemonControlToast(msg)
  if (toast) window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: toast }))
}

/** Coerce an unknown wire field to a string, else undefined. Keeps the daemon
 *  status handlers below branch -- one decision point, not four. */
const wireStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * `daemon_state_patch` -- one cc-daemon `subscribe` state patch, mirrored by
 * the daemon-agent-host (transport-reframe Phase 7 uplift #12d). Stores the
 * worker's own run-state + human-readable detail per conversation so the
 * control panel can show "working -- running tests" instead of scraping the PTY.
 */
function handleDaemonStatePatch(msg: DashboardMessage) {
  const conversationId = wireStr(msg.conversationId)
  if (!conversationId) return
  useConversationsStore.getState().setDaemonStatePatch(conversationId, {
    state: wireStr(msg.state),
    tempo: wireStr(msg.tempo),
    detail: wireStr(msg.detail),
    t: typeof msg.t === 'number' ? msg.t : Date.now(),
  })
}

/** Build the "worker is waiting" toast for a surfaced daemon block. */
function daemonBlockToast(conversationId: string, needs: string | undefined) {
  return {
    title: 'Daemon worker is waiting',
    meta: 'daemon',
    body: needs || 'The worker is at an interaction gate.',
    variant: 'info',
    persistent: false,
    conversationId,
    toastId: `daemon-block:${conversationId}`,
  }
}

/**
 * `daemon_block_observed` -- a daemon worker surfaced an interaction gate.
 * DORMANT in the auto-accept fleet config (Phase 7 spikes 3d/3e); when it does
 * fire, store it (for a header banner) and toast so the user can act.
 */
function handleDaemonBlockObserved(msg: DashboardMessage) {
  const conversationId = wireStr(msg.conversationId)
  if (!conversationId) return
  const needs = wireStr(msg.needs)
  useConversationsStore.getState().setDaemonBlock(conversationId, {
    needs,
    requestId: wireStr(msg.requestId),
    t: typeof msg.t === 'number' ? msg.t : Date.now(),
  })
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: daemonBlockToast(conversationId, needs) }))
}

/**
 * `effort_changed` -- a daemon worker's effort level was set (Phase 7 #1).
 * Live `/effort` is a no-op (spike 3a), so this is a queued-for-respawn record;
 * surface it as a toast so the user knows when it takes effect.
 */
function handleEffortChanged(msg: DashboardMessage) {
  const conversationId = wireStr(msg.conversationId)
  const level = wireStr(msg.level)
  if (!conversationId || !level) return
  window.dispatchEvent(
    new CustomEvent('rclaude-toast', {
      detail: {
        title: `Effort set to ${level}`,
        meta: 'daemon',
        body: 'Applies on the next worker (re)spawn -- daemon effort is set at process start.',
        variant: 'info',
        persistent: false,
        conversationId,
        toastId: `effort-changed:${conversationId}`,
      },
    }),
  )
}

/**
 * `daemon_session_retired` -- a daemon worker was retired by the daemon
 * after a long idle window (typically ~5min). Distinct from a crash. Surfaced
 * as a toast and as a custom event the transcript view can consume to render
 * the "Session retired by daemon -- idle 5m" inline marker.
 */
function handleDaemonSessionRetired(msg: DashboardMessage) {
  const conversationId = typeof msg.conversationId === 'string' ? msg.conversationId : undefined
  if (!conversationId) return
  const short = typeof msg.short === 'string' ? msg.short : undefined
  const idleMs = typeof msg.idleMs === 'number' ? msg.idleMs : 0
  const idleMin = Math.round(idleMs / 60_000)
  const detail = {
    title: 'Session retired by daemon',
    meta: short ? `worker ${short}` : 'daemon',
    body: `Idle for ~${idleMin}min. The daemon retired the worker; revive to continue.`,
    variant: 'info',
    persistent: false,
    conversationId,
    toastId: `daemon-retired:${conversationId}`,
  }
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail }))
  window.dispatchEvent(
    new CustomEvent('rclaude-daemon-session-retired', {
      detail: { conversationId, short, idleMs, lastState: msg.lastState, retiredAt: msg.retiredAt },
    }),
  )
}

/**
 * `cc_version_changed` -- a sentinel observed a Claude Code version or
 * control-protocol bump. Surfaced as a toast so the user notices and can
 * drain in-flight workers; the SentinelManager subscribes to the same
 * custom event to render an inline banner per sentinel row.
 */
function handleCcVersionChanged(msg: DashboardMessage) {
  const sentinelId = typeof msg.sentinelId === 'string' ? msg.sentinelId : undefined
  const toVersion = typeof msg.toVersion === 'string' ? msg.toVersion : undefined
  const toProto = typeof msg.toProto === 'number' ? msg.toProto : undefined
  if (!sentinelId || !toVersion || toProto === undefined) return
  const fromVersion = typeof msg.fromVersion === 'string' ? msg.fromVersion : null
  const fromProto = typeof msg.fromProto === 'number' ? msg.fromProto : null
  const detail = {
    title: 'Claude Code version changed',
    meta: sentinelId,
    body:
      fromVersion === null
        ? `First observed: ${toVersion} (proto ${toProto})`
        : `${fromVersion} -> ${toVersion}${fromProto !== toProto ? ` (proto ${fromProto} -> ${toProto})` : ''}\nConsider draining in-flight workers.`,
    variant: 'warning',
    persistent: true,
    toastId: `cc-version:${sentinelId}`,
  }
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail }))
  window.dispatchEvent(
    new CustomEvent('rclaude-cc-version-changed', {
      detail: { sentinelId, fromVersion, toVersion, fromProto, toProto, observedAt: msg.observedAt },
    }),
  )
}

function handleUsageUpdate(msg: DashboardMessage) {
  if (msg.usage) {
    useConversationsStore.getState().setPlanUsage(msg.usage)
  }
}

function handleSentinelUsageReport(msg: DashboardMessage) {
  if (typeof msg.sentinelId !== 'string' || !Array.isArray(msg.profileUsage)) return
  const polledAt = typeof msg.polledAt === 'number' ? msg.polledAt : Date.now()
  useConversationsStore.getState().setSentinelProfileUsage(msg.sentinelId, msg.profileUsage, polledAt)
}

function handleClaudeHealthUpdate(msg: DashboardMessage) {
  useConversationsStore.getState().setClaudeHealth(msg as unknown as ClaudeHealthUpdate)
}

function handleClaudeEfficiencyUpdate(msg: DashboardMessage) {
  useConversationsStore.getState().setClaudeEfficiency(msg as unknown as ClaudeEfficiencyUpdate)
}

function handleSettingsUpdated(msg: DashboardMessage) {
  if (msg.settings) {
    useConversationsStore.setState({ globalSettings: msg.settings as Record<string, unknown> })
  }
}

function handleLaunchProfilesUpdated(msg: DashboardMessage) {
  if (Array.isArray(msg.launchProfiles)) {
    handleLaunchProfilesUpdatedMessage(msg.launchProfiles as LaunchProfile[])
  }
}

function handleProjectSettingsUpdated(msg: DashboardMessage) {
  if (msg.settings) {
    useConversationsStore.getState().setProjectSettings(msg.settings as ProjectSettingsMap)
  }
}

function handleProjectOrderUpdated(msg: DashboardMessage) {
  if (msg.order) {
    useConversationsStore.getState().setProjectOrder(msg.order as ProjectOrder)
  }
}

function handleSharesUpdated(msg: DashboardMessage) {
  if (msg.shares) {
    useConversationsStore.getState().setShares(msg.shares)
  }
}

// ─── prompts / dialogs ─────────────────────────────────────────────────────

function handleChannelLinkRequest(msg: DashboardMessage) {
  const req = msg as DashboardMessage & {
    fromConversation?: string
    fromProject?: string
    toConversation?: string
    toProject?: string
  }
  const fromConversation = req.fromConversation
  const toConversation = req.toConversation
  if (!(fromConversation && toConversation)) return
  useConversationsStore.setState(state => {
    // Deduplicate
    if (
      state.pendingProjectLinks.some(
        r => r.fromConversation === fromConversation && r.toConversation === toConversation,
      )
    ) {
      return state
    }
    return {
      pendingProjectLinks: [
        ...state.pendingProjectLinks,
        {
          fromConversation,
          fromProject: req.fromProject || fromConversation.slice(0, 8),
          toConversation,
          toProject: req.toProject || toConversation.slice(0, 8),
        },
      ],
    }
  })
}

// Ad-hoc link granted (a sent message referenced another conversation). Surface
// a toast so the auto-authorization is visible to the user (auth_visible).
function handleChannelLinkGranted(msg: DashboardMessage) {
  const g = msg as DashboardMessage & { toProjectLabel?: string; toProject?: string; toConversation?: string }
  const label = g.toProjectLabel || g.toProject || g.toConversation
  if (!label) return
  window.dispatchEvent(
    new CustomEvent('rclaude-toast', {
      detail: {
        title: 'Conversation linked',
        body: `Messaging enabled with ${label}.`,
        variant: 'success',
        toastId: `link-granted:${g.toConversation}`,
      },
    }),
  )
}

function handlePermissionRequest(msg: DashboardMessage) {
  const req = msg as DashboardMessage & {
    requestId?: string
    toolName?: string
    description?: string
    inputPreview?: string
  }
  const permSid = req.conversationId
  const permRid = req.requestId
  if (!(permSid && permRid)) return
  useConversationsStore.setState(state => {
    if (state.pendingPermissions.some(p => p.requestId === permRid)) return state
    return {
      pendingPermissions: [
        ...state.pendingPermissions,
        {
          conversationId: permSid,
          requestId: permRid,
          toolName: req.toolName || 'Unknown',
          description: req.description || '',
          inputPreview: req.inputPreview || '',
          timestamp: Date.now(),
        },
      ],
    }
  })
  // Haptic + visual alert for permission requests (haptic may be silent on iOS outside gestures)
  haptic('double')
}

function handlePermissionAutoApproved(msg: DashboardMessage) {
  const auto = msg as DashboardMessage & {
    requestId?: string
    toolName?: string
    description?: string
  }
  if (!(auto.conversationId && auto.toolName)) return
  // Emit a custom event that the conversation-detail can pick up for a brief toast
  window.dispatchEvent(
    new CustomEvent('permission-auto-approved', {
      detail: { conversationId: auto.conversationId, toolName: auto.toolName, description: auto.description },
    }),
  )
}

// Broker tells us a permission request was resolved (by this or another
// conversation). Drop it from the pending list so the prompt clears everywhere.
function handlePermissionDismiss(msg: DashboardMessage) {
  const permRid = msg.requestId as string | undefined
  if (!(msg.conversationId && permRid)) return
  useConversationsStore.setState(state => {
    if (!state.pendingPermissions.some(p => p.requestId === permRid)) return state
    return { pendingPermissions: state.pendingPermissions.filter(p => p.requestId !== permRid) }
  })
}

function handleAskQuestion(msg: DashboardMessage) {
  const askMsg = msg as DashboardMessage & {
    toolUseId?: string
    questions?: Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string; preview?: string }>
      multiSelect?: boolean
    }>
  }
  const askSid = askMsg.conversationId
  const askTuid = askMsg.toolUseId
  if (!(askSid && askTuid && askMsg.questions)) return
  useConversationsStore.setState(state => {
    if (state.pendingAskQuestions.some(q => q.toolUseId === askTuid)) return state
    return {
      pendingAskQuestions: [
        ...state.pendingAskQuestions,
        {
          conversationId: askSid,
          toolUseId: askTuid,
          questions: askMsg.questions || [],
          timestamp: Date.now(),
        },
      ],
    }
  })
}

// Broker tells us an AskUserQuestion was resolved (by this or another conversation,
// or agent-host side). Drop it from the pending list so the card clears
// everywhere -- not just on the conversation that answered.
function handleAskDismiss(msg: DashboardMessage) {
  const askTuid = msg.toolUseId as string | undefined
  if (!(msg.conversationId && askTuid)) return
  useConversationsStore.setState(state => {
    if (!state.pendingAskQuestions.some(q => q.toolUseId === askTuid)) return state
    return { pendingAskQuestions: state.pendingAskQuestions.filter(q => q.toolUseId !== askTuid) }
  })
}

function handleDialogShow(msg: DashboardMessage) {
  const exSid = msg.conversationId as string
  const exId = msg.dialogId as string
  const exLayout = msg.layout as DialogLayout
  if (!(exSid && exId && exLayout)) return
  // THE DIALOGUE: a persistent dialog renders inline + live (not the blocking
  // modal). Synthesize the initial host snapshot (seq 0 / open / empty state)
  // and route it to the live store; the modal path is for one-shot dialogs.
  if (exLayout.persistent === true) {
    useLiveDialogsStore.getState().show(exSid, { dialogId: exId, layout: exLayout, state: {}, seq: 0, status: 'open' })
    return
  }
  // Dedup: the agent host replays dialog_show on reconnect. If we already
  // have this exact dialog open, preserve any in-progress user input.
  const existing = useConversationsStore.getState().pendingDialogs[exSid]
  if (existing?.dialogId === exId) return
  useConversationsStore.setState(state => ({
    pendingDialogs: {
      ...state.pendingDialogs,
      [exSid]: { dialogId: exId, layout: exLayout, timestamp: Date.now() },
    },
  }))
}

function handleDialogDismiss(msg: DashboardMessage) {
  const exSid = msg.conversationId as string
  if (!exSid) return
  const reason = (msg as DashboardMessage & { reason?: string }).reason
  const exId = msg.dialogId as string | undefined
  useConversationsStore.setState(state => {
    const existing = state.pendingDialogs[exSid]
    // Timeout/cancel: keep the dialog re-displayable (expired pill) instead of
    // removing, so the user can re-trigger it and answer late.
    if ((reason === 'timeout' || reason === 'cancelled') && existing && (!exId || existing.dialogId === exId)) {
      if (existing.expired) return state
      return { pendingDialogs: { ...state.pendingDialogs, [exSid]: { ...existing, expired: true } } }
    }
    const updated = { ...state.pendingDialogs }
    delete updated[exSid]
    return { pendingDialogs: updated }
  })
}

// ─── THE DIALOGUE — live/persistent dialog (host -> broker -> panel) ─────────

/** Parse the (conversationId, snapshot) pair shared by every live handler. */
function liveSnapshot(msg: DashboardMessage): { sid: string; snapshot: DialogSnapshot } | null {
  const sid = msg.conversationId as string
  const snapshot = msg.snapshot as DialogSnapshot | undefined
  return sid && snapshot ? { sid, snapshot } : null
}

function handleDialogPatch(msg: DashboardMessage) {
  const a = liveSnapshot(msg)
  if (!a) return
  const ops = (Array.isArray(msg.ops) ? msg.ops : []) as DialogOp[]
  const rationale = typeof msg.rationale === 'string' ? msg.rationale : undefined
  useLiveDialogsStore.getState().applyPatch(a.sid, a.snapshot, ops, rationale, msg.replay === true)
}

function handleDialogReopen(msg: DashboardMessage) {
  const a = liveSnapshot(msg)
  if (a) useLiveDialogsStore.getState().applyReopen(a.sid, a.snapshot)
}

// A live dialog was authoritatively dismissed (broker dropped the slot) -> drop
// it from this panel's view too.
function handleDialogLiveDismissed(msg: DashboardMessage) {
  const sid = msg.conversationId as string
  const dialogId = msg.dialogId as string
  if (sid && dialogId) useLiveDialogsStore.getState().applyDismissed(sid, dialogId)
}

function handleDialogOrphaned(msg: DashboardMessage) {
  const a = liveSnapshot(msg)
  if (a)
    useLiveDialogsStore
      .getState()
      .applyOrphaned(a.sid, a.snapshot, typeof msg.reason === 'string' ? msg.reason : 'orphaned')
}

// Broker ack for a dialog_event we emitted. ok:false (rate-limited / denied /
// not-interactor) surfaces an error so the panel re-enables controls.
function handleDialogEventResult(msg: DashboardMessage) {
  if (msg.ok !== false) return
  const sid = msg.conversationId as string
  if (!sid) return
  useLiveDialogsStore.getState().setError(sid, typeof msg.error === 'string' ? msg.error : 'rejected')
}

function handlePlanApproval(msg: DashboardMessage) {
  const pa = msg as DashboardMessage & {
    requestId?: string
    toolUseId?: string
    plan?: string
    planFilePath?: string
    allowedPrompts?: string[]
  }
  const paSid = pa.conversationId
  if (!(paSid && pa.requestId && pa.plan)) return
  const dialogId = `plan_${pa.requestId}`
  // Dedup: agent host replays plan_approval on reconnect so the broker
  // can rebuild pending state. If we already have this exact dialog open,
  // don't overwrite -- would wipe any feedback the user has typed.
  const existing = useConversationsStore.getState().pendingDialogs[paSid]
  if (existing?.dialogId === dialogId && existing.source === 'plan_approval') return
  // Build a dialog layout from the plan content
  const layout: DialogLayout = {
    title: 'Plan Approval',
    timeout: 600,
    // Approve = exit plan mode and run. "Request changes" = reject + send the
    // feedback back to the agent so it revises (CC ignores feedback on approve,
    // so the textarea only travels with reject). The header X = plain dismiss.
    submitLabel: 'Approve & run',
    secondaryAction: { id: 'reject', label: 'Request changes', intent: 'destructive' },
    body: [
      { type: 'Markdown', content: pa.plan },
      { type: 'Divider' },
      {
        type: 'TextInput',
        id: 'feedback',
        label: 'What to change (sent to the agent if you request changes)',
        placeholder: 'What should the agent do differently?',
        multiline: true,
      },
    ],
  }
  useConversationsStore.setState(state => ({
    pendingDialogs: {
      ...state.pendingDialogs,
      [paSid]: {
        dialogId,
        layout,
        timestamp: Date.now(),
        source: 'plan_approval',
        meta: { requestId: pa.requestId, toolUseId: pa.toolUseId },
      },
    },
  }))
  haptic('double')
}

function handlePlanApprovalDismissed(msg: DashboardMessage) {
  const sid = msg.conversationId
  if (!sid) return
  useConversationsStore.setState(state => {
    const pending = state.pendingDialogs[sid]
    if (pending?.source === 'plan_approval') {
      const { [sid]: _, ...rest } = state.pendingDialogs
      return { pendingDialogs: rest }
    }
    return state
  })
}

function handleClipboardCapture(msg: DashboardMessage) {
  const clipMsg = msg as DashboardMessage & {
    contentType?: 'text' | 'image'
    text?: string
    base64?: string
    mimeType?: string
    timestamp?: number
  }
  if (!(clipMsg.conversationId && clipMsg.contentType)) return
  useConversationsStore.setState(state => {
    const capture = {
      id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      conversationId: clipMsg.conversationId || '',
      contentType: clipMsg.contentType || ('text' as const),
      text: clipMsg.text,
      base64: clipMsg.base64,
      mimeType: clipMsg.mimeType,
      timestamp: clipMsg.timestamp || Date.now(),
    }
    // Stack max 4, drop oldest
    const next = [capture, ...state.clipboardCaptures].slice(0, 4)
    return { clipboardCaptures: next }
  })
}

function handleConversationDismissed(msg: DashboardMessage) {
  if (!msg.conversationId) return
  const conversationId = msg.conversationId
  forgetFull(conversationId)
  useConversationsStore.setState(state => dropConversationPatch(state, conversationId, 'session_dismissed'))
}

// Server-pushed permissions (resolved from grants)
function handlePermissions(msg: DashboardMessage) {
  const update: Record<string, unknown> = {}
  if (msg.global) update.permissions = msg.global
  if (msg.conversations) {
    // Merge into existing conversationPermissions (incremental updates for new conversation)
    update.conversationPermissions = {
      ...useConversationsStore.getState().conversationPermissions,
      ...msg.conversations,
    }
  }
  if (Object.keys(update).length > 0) useConversationsStore.setState(update)
}

// ─── results + job events ──────────────────────────────────────────────────

const ACTION_TITLES: Record<string, string> = {
  send_input_result: 'Message not delivered',
  dismiss_conversation_result: 'Dismiss failed',
  dismiss_session_result: 'Dismiss failed',
  update_settings_result: 'Settings update failed',
  update_project_settings_result: 'Project settings update failed',
  delete_project_settings_result: 'Project settings delete failed',
  update_project_order_result: 'Reorder failed',
  revive_conversation_result: 'Revive failed',
  revive_session_result: 'Revive failed',
  rename_conversation_result: 'Rename failed',
  conversation_control_result: 'Control action failed',
  recap_request_result: 'Recap failed',
}

function handleActionResult(msg: DashboardMessage) {
  if (msg.ok === false) {
    const type = (msg.type as string) || 'action'
    const error = (msg.error as string) || 'unknown error'
    console.error(`[ws] ${type}: ${error}`)
    const title = ACTION_TITLES[type] ?? `Action failed: ${type}`
    window.dispatchEvent(
      new CustomEvent('rclaude-toast', {
        detail: { title, body: error, variant: 'warning' },
      }),
    )
  }
  window.dispatchEvent(new CustomEvent('revive-conversation-result', { detail: msg }))
}

function handleReviveResult(msg: DashboardMessage) {
  // Agent's revive result -- forwarded by broker for pipeline tracking
  window.dispatchEvent(new CustomEvent('revive-agent-result', { detail: msg }))
}

function handleLaunchJobEvent(msg: DashboardMessage) {
  window.dispatchEvent(new CustomEvent('launch-job-event', { detail: msg }))
}

// ─── recap job widget ──────────────────────────────────────────────────────

function handleRecapProgress(msg: DashboardMessage) {
  useRecapJobsStore.getState().applyProgress(msg as unknown as RecapProgressMessage)
}

function handleRecapComplete(msg: DashboardMessage) {
  useRecapJobsStore.getState().applyComplete(msg as unknown as RecapCompleteMessage)
}

function handleRecapCreated(msg: DashboardMessage) {
  useRecapJobsStore.getState().applyCreated(
    msg as unknown as RecapCreatedMessage & {
      projectUri?: string
      periodLabel?: RecapPeriodLabel
    },
  )
}

function handleRecapRegenerated(msg: DashboardMessage) {
  // Reply to a dashboard-triggered recap_regenerate. Surface the new fork's id
  // so the open viewer can switch to / group the variant. The viewer polls the
  // fork over HTTP for progress; this event only carries lineage.
  const m = msg as unknown as RecapRegeneratedMessage
  window.dispatchEvent(
    new CustomEvent('rclaude-recap-forked', {
      detail: { recapId: m.recapId, sourceRecapId: m.sourceRecapId, mode: m.mode },
    }),
  )
}

function handleRecapError(msg: DashboardMessage) {
  // The broker echoes recap_error with optional requestId; the dashboard's
  // create flow stamps a recapId on its outbound recap_create when it knows
  // it. For broker-side errors that don't carry a recapId we still surface
  // a toast so the user sees what failed.
  useRecapJobsStore.getState().applyError(msg as unknown as RecapErrorMessage)
  if (typeof msg.error === 'string') {
    window.dispatchEvent(
      new CustomEvent('rclaude-toast', {
        detail: { title: 'Recap error', body: msg.error, variant: 'warning' },
      }),
    )
  }
}

function handleRecapListResult(msg: DashboardMessage) {
  const recaps = msg.recaps as RecapSummary[] | undefined
  if (Array.isArray(recaps)) useRecapJobsStore.getState().syncFromList(recaps)
}

function handleSpawnRequestAckMsg(msg: DashboardMessage) {
  handleSpawnRequestAck(
    msg as unknown as {
      type: 'spawn_request_ack'
      ok: boolean
      jobId?: string
      conversationId?: string
      tmuxSession?: string
      error?: string
    },
  )
}

// ─── rate limit status ──────────────────────────────────────────────────────

/**
 * Dismissal TTL for rate-limit toasts. Keyed on {sentinel}:{profile}:{type} --
 * NOT conversationId -- so dismissing once silences every conversation that
 * shares the same account+sentinel+bucket. Tunable via localStorage pref
 * `rclaude.rateLimitDismissTtlMs`. Minimum 5 min.
 */
const RATE_LIMIT_DISMISS_MIN_MS = 5 * 60 * 1000

function getRateLimitDismissTtlMs(): number {
  try {
    const raw = localStorage.getItem('rclaude.rateLimitDismissTtlMs')
    const n = raw ? parseInt(raw, 10) : NaN
    if (Number.isFinite(n) && n >= RATE_LIMIT_DISMISS_MIN_MS) return n
  } catch {}
  return RATE_LIMIT_DISMISS_MIN_MS
}

function rateLimitDismissalKey(sentinel: string, profile: string, rateLimitType: string): string {
  return `rate-limit-dismissed:${sentinel}:${profile}:${rateLimitType}`
}

interface RateLimitFields {
  status: string | undefined
  conversationId: string | undefined
  retryAfterMs: number | undefined
  resetsAt: number | undefined
  rateLimitType: string
  utilization: number | undefined
  profile: string
  sentinelKey: string
  sentinelAlias: string
}

// Live per-message token sample -> the token-flow ring (outside React/Zustand,
// so the high-frequency fleet stream never churns the store). The widget reads
// the ring via useSyncExternalStore.
function handleTokenSample(msg: DashboardMessage): void {
  recordTokenSample({
    ts: (msg.timestamp as number | undefined) || Date.now(),
    sentinelId: (msg.sentinelId as string | undefined) || '',
    profile: (msg.profile as string | undefined) || 'default',
    model: (msg.model as string | undefined) || '',
    input: (msg.inputTokens as number | undefined) || 0,
    output: (msg.outputTokens as number | undefined) || 0,
    cacheRead: (msg.cacheReadTokens as number | undefined) || 0,
    cacheWrite: (msg.cacheWriteTokens as number | undefined) || 0,
  })
}

// Inter-conversation send observed (sender-project scoped broadcast). Pushed
// into the store's small activity ring; THE CANVAS animates these as pulses.
function handleInterConversationActivity(msg: DashboardMessage): void {
  const from = msg.conversationId as string | undefined
  const to = msg.toConversationId as string | undefined
  if (!from || !to) return
  useConversationsStore.getState().pushInterConvActivity({
    from,
    to,
    intent: (msg.intent as string | undefined) || 'notify',
    status: msg.status === 'queued' ? 'queued' : 'delivered',
    at: (msg.at as number | undefined) || Date.now(),
  })
}

// Live thinking-progress ping -> per-conversation ring outside React/Zustand.
// Ephemeral: dropped after a 4s idle window, cleared when a new transcript
// entry arrives. The ThinkingPill component reads via useSyncExternalStore.
function handleThinkingProgress(msg: DashboardMessage): void {
  const conversationId = msg.conversationId as string | undefined
  const tokens = msg.tokens as number | undefined
  if (!conversationId || typeof tokens !== 'number') return
  recordThinkingProgress(conversationId, {
    tokens,
    delta: typeof msg.delta === 'number' ? (msg.delta as number) : undefined,
    t: (msg.t as number | undefined) || Date.now(),
  })
}

// ─── host shells (roster plane) ──────────────────────────────────────────────
// The data plane (shell_data / shell_replay) bypasses this table -- it is routed
// straight to the mounted ShellPane in use-websocket.ts. Only the low-frequency
// roster deltas land here. All four are permission-filtered by the broker before
// they reach this client (terminal:read per-URI), so no client-side gating.

function handleShellRoster(msg: DashboardMessage): void {
  const shells = msg.shells as ShellRosterEntry[] | undefined
  if (Array.isArray(shells)) useShellsStore.getState().setRoster(shells)
}

function handleShellAdded(msg: DashboardMessage): void {
  const shell = msg.shell as ShellRosterEntry | undefined
  if (shell?.shellId) useShellsStore.getState().addShell(shell)
}

function handleShellRemoved(msg: DashboardMessage): void {
  const shellId = typeof msg.shellId === 'string' ? msg.shellId : undefined
  if (shellId) useShellsStore.getState().removeShell(shellId)
}

function handleShellActivity(msg: DashboardMessage): void {
  const shellId = typeof msg.shellId === 'string' ? msg.shellId : undefined
  if (!shellId) return
  useShellsStore.getState().markActivity(shellId, typeof msg.ts === 'number' ? msg.ts : Date.now())
}

/** `shell_open_result { ok:false, error }` -- the broker's auto-reply when a
 *  `shell_open` was rejected (perm gate / unknown sentinel / spawn failure).
 *  Surface it so the failed open is visible. A successful open is silent (the
 *  tile appears via shell_added). */
function handleShellOpenResult(msg: DashboardMessage): void {
  if (msg.ok !== false) return
  window.dispatchEvent(
    new CustomEvent('rclaude-toast', {
      detail: {
        title: 'Shell could not open',
        body: typeof msg.error === 'string' ? msg.error : 'unknown error',
        variant: 'warning',
      },
    }),
  )
}

function handleDebugTraceEvent(msg: DashboardMessage): void {
  const traceId = msg.traceId as string | undefined
  if (!traceId) return
  addDebugTraceEvent(traceId, {
    seam: (msg.seam as string) || 'unknown',
    t: (msg.t as number | undefined) || Date.now(),
    ok: typeof msg.ok === 'boolean' ? msg.ok : undefined,
    detail: typeof msg.detail === 'string' ? msg.detail : undefined,
    raw: msg.raw,
  })
}

function handleConversationAuthNeeded(msg: DashboardMessage): void {
  const conversationId = msg.conversationId as string | undefined
  if (!conversationId) return
  setAuthNeeded(conversationId, {
    errorStatus: (msg.errorStatus as number | undefined) || 401,
    detail: typeof msg.detail === 'string' ? msg.detail : undefined,
    at: (msg.timestamp as number | undefined) || Date.now(),
  })
}

function handleDebugControlResult(msg: DashboardMessage): void {
  const traceId = msg.traceId as string | undefined
  if (!traceId) return
  setDebugTraceResult(traceId, {
    ok: !!msg.ok,
    response: msg.response,
    error: typeof msg.error === 'string' ? msg.error : undefined,
    code: typeof msg.code === 'string' ? msg.code : undefined,
    elapsedMs: (msg.elapsedMs as number | undefined) || 0,
  })
}

function extractRateLimitFields(msg: DashboardMessage): RateLimitFields {
  const info = (msg.raw as Record<string, unknown>)?.rate_limit_info as Record<string, unknown> | undefined
  const sentinelId = (msg.sentinelId as string | undefined) || ''
  const sentinelAlias = (msg.sentinelAlias as string | undefined) || sentinelId || 'sentinel'
  return {
    status: msg.status as string | undefined,
    conversationId: msg.conversationId as string | undefined,
    retryAfterMs: msg.retryAfterMs as number | undefined,
    resetsAt: msg.resetsAt as number | undefined,
    rateLimitType: (msg.rateLimitType as string | undefined) ?? 'unknown',
    utilization: info?.utilization as number | undefined,
    profile: (msg.profile as string | undefined) || 'default',
    sentinelKey: sentinelId || sentinelAlias,
    sentinelAlias,
  }
}

function isDismissed(key: string, now: number): boolean {
  const v = localStorage.getItem(key)
  if (!v) return false
  const dismissedAt = parseInt(v, 10)
  return Number.isFinite(dismissedAt) && dismissedAt > now - getRateLimitDismissTtlMs()
}

function registerDismissOnce(toastId: string, dismissalKey: string): void {
  const handler = () => {
    try {
      localStorage.setItem(dismissalKey, Date.now().toString())
    } catch {}
  }
  window.addEventListener(`toast-dismissed:${toastId}`, handler, { once: true })
}

function buildRateLimitDetail(f: RateLimitFields, isNotice: boolean, toastId: string) {
  const limitLabel = formatRateBucketName(f.rateLimitType)
  const utilizationPct = f.utilization != null ? Math.round(f.utilization * 100) : undefined
  const meta = utilizationPct != null ? `${limitLabel} · ${utilizationPct}%` : limitLabel
  const resetText = formatResetIn(f.resetsAt)
  const identity = `${f.profile} @ ${f.sentinelAlias}`
  const body = resetText ? `${identity}\n${resetText.charAt(0).toUpperCase()}${resetText.slice(1)}` : identity
  const isCritical = (f.utilization ?? 0) >= 0.75
  return {
    title: isNotice ? 'Rate Limit Notice' : 'Rate Limited',
    meta,
    body,
    variant: 'warning',
    persistent: isCritical || !isNotice,
    conversationId: f.conversationId,
    toastId,
  }
}

function handleRateLimitStatus(msg: DashboardMessage) {
  const f = extractRateLimitFields(msg)
  if (f.status === 'allowed') return

  const isNotice = f.retryAfterMs === undefined
  const dismissalKey = rateLimitDismissalKey(f.sentinelKey, f.profile, f.rateLimitType)
  if (isDismissed(dismissalKey, Date.now())) return

  const toastId = `rate-limit:${f.sentinelKey}:${f.profile}:${f.rateLimitType}`
  const detail = buildRateLimitDetail(f, isNotice, toastId)
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail }))
  registerDismissOnce(toastId, dismissalKey)
}

// ─── dispatch table ────────────────────────────────────────────────────────

export type MessageHandler = (msg: DashboardMessage) => void

function handleDispatchRequestResult(msg: DashboardMessage) {
  useDispatchStore
    .getState()
    .onRequestResult(msg as DashboardMessage & { ok?: boolean; error?: string; decision?: DispatchDecision })
}

function handleDispatchControlResult(msg: DashboardMessage) {
  const data = msg as DashboardMessage & {
    action?: string
    content?: string
    before?: string
    after?: string
    model?: string
    ok?: boolean
    error?: string
  }
  useDispatchStore.getState().onControlResult(data)
}

function handleDispatchThreadsResult(msg: DashboardMessage) {
  useDispatchStore.getState().onThreadsResult(
    msg as DashboardMessage & {
      threads?: DispatchThread[]
      roster?: DispatchCandidate[]
      history?: DispatchHistoryDump
      userId?: string | null
    },
  )
}

function handleDispatchHistory(msg: DashboardMessage) {
  useDispatchStore
    .getState()
    .onHistory(msg as DashboardMessage & { history?: DispatchHistoryDump; userId?: string | null })
}

function handleDispatchDecision(msg: DashboardMessage) {
  useDispatchStore.getState().onDecisionBroadcast(msg as unknown as DispatchDecision)
}

function handleDispatchToolCall(msg: DashboardMessage) {
  useDispatchStore.getState().onToolCall(msg as unknown as DispatchToolCall)
}

function handleDispatchToolResult(msg: DashboardMessage) {
  useDispatchStore.getState().onToolResult(msg as unknown as DispatchToolResult)
}

function handleSotuFleetResult(msg: DashboardMessage) {
  window.dispatchEvent(new CustomEvent('sotu-ws', { detail: msg }))
}

function handleSotuViewResult(msg: DashboardMessage) {
  window.dispatchEvent(new CustomEvent('sotu-ws', { detail: msg }))
}

function handleSotuContribution(msg: DashboardMessage) {
  window.dispatchEvent(new CustomEvent('sotu-ws', { detail: msg }))
}

function handleSotuUpdated(msg: DashboardMessage) {
  window.dispatchEvent(new CustomEvent('sotu-ws', { detail: msg }))
}

export const handlers: Record<string, MessageHandler> = {
  // sync
  sync_ok: handleSyncOk,
  sync_catchup: handleSyncCatchup,
  sync_stale: handleSyncStale,
  // conversation lifecycle
  conversations_list: handleConversationsList,
  conversation_created: handleConversationCreated,
  conversation_ended: handleConversationUpdate,
  conversation_update: handleConversationUpdate,
  conversation_patch: handleConversationPatch,
  channel_ack: handleChannelAck,
  event: handleEvent,
  // transcripts + streaming
  transcript_entries: handleTranscriptEntries,
  conversation_info: handleConversationInfo,
  stream_delta: handleStreamDelta,
  subagent_transcript: handleSubagentTranscript,
  // tasks / sentinel / settings
  tasks_update: handleTasksUpdate,
  sentinel_status: handleSentinelStatus,
  daemon_roster: handleDaemonRoster,
  daemon_control_result: handleDaemonControlResult,
  daemon_session_retired: handleDaemonSessionRetired,
  daemon_state_patch: handleDaemonStatePatch,
  daemon_block_observed: handleDaemonBlockObserved,
  effort_changed: handleEffortChanged,
  cc_version_changed: handleCcVersionChanged,
  usage_update: handleUsageUpdate,
  sentinel_usage_report: handleSentinelUsageReport,
  token_sample: handleTokenSample,
  inter_conversation_activity: handleInterConversationActivity,
  // host shells (roster plane)
  shell_roster: handleShellRoster,
  shell_added: handleShellAdded,
  shell_removed: handleShellRemoved,
  shell_activity: handleShellActivity,
  shell_open_result: handleShellOpenResult,
  thinking_progress: handleThinkingProgress,
  debug_trace_event: handleDebugTraceEvent,
  debug_control_result: handleDebugControlResult,
  conversation_auth_needed: handleConversationAuthNeeded,
  claude_health_update: handleClaudeHealthUpdate,
  claude_efficiency_update: handleClaudeEfficiencyUpdate,
  rate_limit_status: handleRateLimitStatus,
  settings_updated: handleSettingsUpdated,
  launch_profiles_updated: handleLaunchProfilesUpdated,
  project_settings_updated: handleProjectSettingsUpdated,
  project_order_updated: handleProjectOrderUpdated,
  shares_updated: handleSharesUpdated,
  // prompts + dialogs
  channel_link_request: handleChannelLinkRequest,
  channel_link_granted: handleChannelLinkGranted,
  permission_request: handlePermissionRequest,
  permission_dismiss: handlePermissionDismiss,
  permission_auto_approved: handlePermissionAutoApproved,
  ask_question: handleAskQuestion,
  ask_dismiss: handleAskDismiss,
  dialog_show: handleDialogShow,
  dialog_dismiss: handleDialogDismiss,
  dialog_patch: handleDialogPatch,
  dialog_reopen: handleDialogReopen,
  dialog_orphaned: handleDialogOrphaned,
  dialog_live_dismissed: handleDialogLiveDismissed,
  dialog_event_result: handleDialogEventResult,
  plan_approval: handlePlanApproval,
  plan_approval_dismissed: handlePlanApprovalDismissed,
  clipboard_capture: handleClipboardCapture,
  conversation_dismissed: handleConversationDismissed,
  permissions: handlePermissions,
  // results + job events
  send_input_result: handleActionResult,
  dismiss_conversation_result: handleActionResult,
  dismiss_session_result: handleActionResult, // backward compat
  update_settings_result: handleActionResult,
  update_project_settings_result: handleActionResult,
  delete_project_settings_result: handleActionResult,
  update_project_order_result: handleActionResult,
  revive_conversation_result: handleActionResult,
  revive_session_result: handleActionResult, // backward compat
  recap_request_result: handleActionResult,
  revive_result: handleReviveResult,
  launch_log: handleLaunchJobEvent,
  launch_progress: handleLaunchJobEvent,
  job_complete: handleLaunchJobEvent,
  job_failed: handleLaunchJobEvent,
  spawn_request_ack: handleSpawnRequestAckMsg,
  // recap jobs widget
  recap_progress: handleRecapProgress,
  recap_complete: handleRecapComplete,
  recap_created: handleRecapCreated,
  recap_regenerated: handleRecapRegenerated,
  recap_error: handleRecapError,
  recap_list_result: handleRecapListResult,
  // dispatch cockpit (per-user Front Desk overlay)
  dispatch_request_result: handleDispatchRequestResult,
  dispatch_control_result: handleDispatchControlResult,
  dispatch_list_threads_result: handleDispatchThreadsResult,
  dispatch_history: handleDispatchHistory,
  dispatch_decision: handleDispatchDecision,
  dispatch_tool_call: handleDispatchToolCall,
  dispatch_tool_result: handleDispatchToolResult,
  // SOTU dashboard reads + live push
  sotu_fleet_result: handleSotuFleetResult,
  sotu_view_result: handleSotuViewResult,
  sotu_contribution: handleSotuContribution,
  sotu_updated: handleSotuUpdated,
}
