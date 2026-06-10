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

import type { DialogLayout } from '@shared/dialog-schema'
import { formatResetIn } from '@shared/format-reset-time'
import type { LaunchProfile } from '@shared/launch-profile'
import type {
  ConversationSummary,
  RecapCompleteMessage,
  RecapCreatedMessage,
  RecapErrorMessage,
  RecapPeriodLabel,
  RecapProgressMessage,
  RecapRegeneratedMessage,
  RecapSummary,
  ShellRosterEntry,
} from '@shared/protocol'
import { handleLaunchProfilesUpdatedMessage } from '@/components/launch-profiles/use-launch-profiles'
import { daemonControlToast } from '@/lib/daemon-control'
import { record } from '@/lib/perf-metrics'
import { buildSlimIndexWithSelected, forgetFull, rememberFull, slimConversation } from '@/lib/slim-conversation'
import { cachePushEntries } from '@/lib/transcript-page-cache'
import type {
  ClaudeEfficiencyUpdate,
  ClaudeHealthUpdate,
  Conversation,
  ProjectOrder,
  TaskInfo,
  TranscriptEntry,
} from '@/lib/types'
import { formatRateBucketName, haptic } from '@/lib/utils'
import { addDebugTraceEvent, setDebugTraceResult } from './debug-control-store'
import { clearThinkingProgress, recordThinkingProgress } from './thinking-progress-store'
import { recordTokenSample } from './token-flow-store'
import { applyHashRoute, fetchTranscript, type ProjectSettingsMap, useConversationsStore } from './use-conversations'
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
    // Spawn lineage (Phase 3 carries parent/root over WS; directChildCount is
    // REST-only, so it stays undefined here and the UI walks the local list).
    parentConversationId: summary.parentConversationId,
    rootConversationId: summary.rootConversationId,
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

function handleSyncStale(msg: DashboardMessage) {
  const stale = msg as DashboardMessage & { reason?: string; missed?: number; epoch?: string; seq?: number }
  const staleTranscripts = (msg as DashboardMessage & { staleTranscripts?: Record<string, number> }).staleTranscripts
  const staleInfo = staleTranscripts ? ` staleTranscripts=${Object.keys(staleTranscripts).length}` : ''
  console.log(`[sync] <- sync_stale: ${stale.reason || 'unknown'} missed=${stale.missed || '?'}${staleInfo}`)
  // Full resync needed - bump connectSeq (triggers LIFO eviction + re-fetch in onopen).
  // Clear lastAppliedTranscriptSeq: epoch changed means server's per-conversation
  // seq counters reset, so our stored seqs are from the previous generation
  // and would false-negative a future sync_check. The upcoming initial
  // transcript_entries broadcasts will reseed from fresh seqs.
  useConversationsStore.setState(s => ({
    connectSeq: s.connectSeq + 1,
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
    rememberFull(fullConversation, state.selectedConversationId)
    const slim = slimConversation(fullConversation)
    let conversations: Conversation[]
    if (state.conversations.some(s => s.id === slim.id)) {
      conversations = state.conversations.map(s => (s.id === slim.id ? { ...s, ...slim } : s))
    } else {
      conversations = [...state.conversations, slim]
    }
    return {
      conversations,
      conversationsById: buildSlimIndexWithSelected(conversations, state.selectedConversationId),
    }
  })
}

function handleConversationUpdate(msg: DashboardMessage) {
  if (!(msg.conversation && msg.conversationId)) return
  const conversationId = msg.conversationId
  const conversation = msg.conversation
  const prevId = msg.previousConversationId
  const matchId = prevId || conversationId
  useConversationsStore.setState(state => {
    const updated = toConversation(conversation)
    // Rekey collision: if two booting placeholders (different conversationIds)
    // both get rekeyed to the same real conversation id, the map-replace leaves
    // two entries in the array with identical `updated.id`. Dedupe by id
    // (merge any duplicates into the first occurrence) so the sidebar
    // doesn't render ghost rows. Without dedupe, a double-spawn shows as
    // two identical conversation rows sharing a short-id.
    //
    // The merge `{ ...s, ...updated }` (slim base + full update) yields the new
    // full payload; remember it in the side-map, then slim it for list residency.
    const selectedId = state.selectedConversationId
    // On rekey, the old prevId full payload in the side-map is now orphaned.
    if (prevId && prevId !== conversationId) forgetFull(prevId)
    const replaced = state.conversations.map(s => {
      if (s.id !== matchId) return s
      const merged = { ...s, ...updated }
      rememberFull(merged, selectedId)
      return slimConversation(merged)
    })
    const seen = new Set<string>()
    const conversations: Conversation[] = []
    for (const s of replaced) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      conversations.push(s)
    }
    const newState: Partial<typeof state> = {
      conversations,
      conversationsById: buildSlimIndexWithSelected(conversations, selectedId),
    }
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
      newState.selectedConversationId = conversationId
      const oldEvents = state.events[prevId]
      const oldTranscripts = state.transcripts[prevId]
      if (oldEvents || oldTranscripts) {
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
    }
    return newState
  })
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
  if (!initial && newEntries.length > 0) clearThinkingProgress(sid)
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
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      const text = delta.text as string
      useConversationsStore.setState(state => {
        const updated = (state.streamingText[sid] || '') + text
        // Bump newDataSeq every ~500 chars to trigger auto-scroll without thrashing
        const prevLen = (state.streamingText[sid] || '').length
        const bumpScroll = Math.floor(updated.length / 500) > Math.floor(prevLen / 500)
        return {
          streamingText: { ...state.streamingText, [sid]: updated },
          ...(bumpScroll ? { newDataSeq: state.newDataSeq + 1 } : {}),
        }
      })
    } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const text = delta.thinking as string
      useConversationsStore.setState(state => {
        const updated = (state.streamingThinking[sid] || '') + text
        const prevLen = (state.streamingThinking[sid] || '').length
        const bumpScroll = Math.floor(updated.length / 500) > Math.floor(prevLen / 500)
        return {
          streamingThinking: { ...state.streamingThinking, [sid]: updated },
          ...(bumpScroll ? { newDataSeq: state.newDataSeq + 1 } : {}),
        }
      })
    }
  } else if (eventType === 'message_start') {
    // New message -- reset BOTH streaming buffers for a clean slate. Do NOT
    // reset on content_block_start: a single assistant message can have
    // multiple blocks (interleaved tool_use / thinking / text) and resetting
    // on each block wipes earlier deltas before the committed entry lands.
    // Resetting per-message is correct: the prior message's content has
    // already committed (and cleared these buffers) by the time the next
    // message_start fires.
    useConversationsStore.setState(state => {
      const next: Partial<typeof state> = {}
      if (state.streamingText[sid]) next.streamingText = { ...state.streamingText, [sid]: '' }
      if (state.streamingThinking[sid]) next.streamingThinking = { ...state.streamingThinking, [sid]: '' }
      return next
    })
  } else if (eventType === 'message_stop') {
    // Turn complete -- clear streaming TEXT (committed entry replaces it).
    // Keep streaming THINKING: committed entries don't contain thinking
    // blocks, so this is the only copy. It persists until message_start
    // resets it (next turn) or conversation switch clears it.
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
  forgetFull(msg.conversationId)
  useConversationsStore.setState(state => {
    const conversations = state.conversations.filter(s => s.id !== msg.conversationId)
    if (state.selectedConversationId === msg.conversationId) {
      console.log(`[nav] session_dismissed: clearing selection (WS dismissed ${msg.conversationId.slice(0, 8)})`)
    }
    const nextSelected = state.selectedConversationId === msg.conversationId ? null : state.selectedConversationId
    return {
      conversations,
      conversationsById: buildSlimIndexWithSelected(conversations, nextSelected),
      selectedConversationId: nextSelected,
    }
  })
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
  // host shells (roster plane)
  shell_roster: handleShellRoster,
  shell_added: handleShellAdded,
  shell_removed: handleShellRemoved,
  shell_activity: handleShellActivity,
  shell_open_result: handleShellOpenResult,
  thinking_progress: handleThinkingProgress,
  debug_trace_event: handleDebugTraceEvent,
  debug_control_result: handleDebugControlResult,
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
}
