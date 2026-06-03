/**
 * WebSocket hook for real-time updates from broker
 *
 * Uses rAF buffering + unstable_batchedUpdates to coalesce multiple WS messages
 * into a single React render per frame. Latency-sensitive handlers (terminal, file,
 * toast) bypass the buffer and dispatch immediately.
 */
import { useCallback, useEffect, useRef } from 'react'
import { unstable_batchedUpdates as batchUpdates } from 'react-dom'

// Graceful fallback if unstable_batchedUpdates is ever removed
const batch: (fn: () => void) => void = batchUpdates ?? (fn => fn())

import { isPerfEnabled, record as perfRecord } from '@/lib/perf-metrics'
import { buildWsUrl } from '@/lib/share-mode'
import { cachePushEntries } from '@/lib/transcript-page-cache'
import { resubscribeAgentScopes, subscribeAgentScope, unsubscribeAgentScope } from './agent-scope-subscription'
import {
  fetchTranscript,
  handleBgTaskOutputMessage,
  resolveConfigResponse,
  useConversationsStore,
} from './use-conversations'
import { dispatchShellData } from './use-shells'
import { type DashboardMessage, handlers } from './use-websocket-handlers'
import { recordIn, recordOut } from './ws-stats'

let _wsUrl: string | null = null
function getWsUrl() {
  if (!_wsUrl) _wsUrl = buildWsUrl()
  return _wsUrl
}
const RECONNECT_DELAY_MS = 2000
const CONVERSATION_CHANNELS = [
  'conversation:events',
  'conversation:transcript',
  'conversation:tasks',
  'conversation:bg_output',
] as const

// --- rAF message buffer (module-level, outside React) ---
let msgBuffer: DashboardMessage[] = []
let rafScheduled = false

// Module-level subscription tracking - must be clearable from onopen handler
let _subscribedConversations = new Set<string>()
function clearSubscribedConversations() {
  _subscribedConversations = new Set<string>()
}

/**
 * Flush buffered messages in a single batched update.
 * All Zustand setState calls inside unstable_batchedUpdates
 * are coalesced into one React render.
 */
function flushMessages() {
  rafScheduled = false
  if (msgBuffer.length === 0) return

  const pending = msgBuffer
  msgBuffer = []

  // Track sync state (epoch+seq) from incoming messages
  const { syncSeq: prevSeq, syncEpoch: prevEpoch } = useConversationsStore.getState()
  let maxSeq = prevSeq
  let epoch = prevEpoch
  for (const msg of pending) {
    const m = msg as DashboardMessage & { _epoch?: string; _seq?: number }
    if (m._epoch && m._seq) {
      epoch = m._epoch
      if (m._seq > maxSeq) maxSeq = m._seq
    }
  }
  if (maxSeq > prevSeq || epoch !== prevEpoch) {
    useConversationsStore.setState({ syncEpoch: epoch, syncSeq: maxSeq })
  }

  const flushT0 = isPerfEnabled() ? performance.now() : 0
  batch(() => {
    for (const msg of pending) {
      processMessage(msg)
    }
  })
  if (flushT0) perfRecord('ws', 'flush', performance.now() - flushT0, summarizeFlush(pending))
}

function summarizeFlush(pending: DashboardMessage[]): string {
  const types: Record<string, number> = {}
  for (const msg of pending) {
    const t = (msg as { type?: string }).type ?? 'unknown'
    types[t] = (types[t] ?? 0) + 1
  }
  const detail = Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => (n === 1 ? t : `${t}x${n}`))
    .join(',')
  return `n=${pending.length} ${detail}`
}

// Server now reports staleTranscripts as { [sid]: serverLastSeq }. Compare
// against our lastAppliedTranscriptSeq to decide what to refetch, and fetch
// via ?sinceSeq=N delta so we only pull the gap rather than the entire tail.
//
// Edge case: server returns `gap: true` when its cache has evicted entries
// older than our sinceSeq (MAX_TRANSCRIPT_ENTRIES rolled over past us). Treat
// gap=true as "full replace with what you got", not an append -- otherwise
// we'd have a hole between our lastAppliedSeq and the first returned seq.
function refetchStaleTranscripts(staleTranscripts?: Record<string, number>): void {
  if (!staleTranscripts) return
  const { lastAppliedTranscriptSeq, setTranscript } = useConversationsStore.getState()
  const sids = Object.keys(staleTranscripts)
  const actuallyStale = sids.filter(s => {
    const localSeq = lastAppliedTranscriptSeq[s] ?? 0
    const serverSeq = staleTranscripts[s]
    return serverSeq > localSeq
  })
  if (actuallyStale.length === 0) {
    console.log(`[sync] staleTranscripts=${sids.length} all-in-sync (no refetch)`)
    return
  }
  console.log(
    `[sync] STALE transcripts: ${actuallyStale
      .map(s => `${s.slice(0, 8)} serverSeq=${staleTranscripts[s]} localSeq=${lastAppliedTranscriptSeq[s] ?? 0}`)
      .join(', ')}`,
  )
  for (const sid of actuallyStale) {
    const sinceSeq = lastAppliedTranscriptSeq[sid] ?? 0
    fetchTranscript(sid, sinceSeq).then(result => {
      if (!result) {
        console.log(`[sync] REFETCH transcript ${sid.slice(0, 8)}: FAILED (null response)`)
        return
      }
      if (result.gap) {
        // Server couldn't fulfil the delta (we were behind by more than the
        // cache holds). Full replace from whatever server has.
        console.log(
          `[sync] REFETCH transcript ${sid.slice(0, 8)}: GAP delta=${result.entries.length} lastSeq=${result.lastSeq} -- full replace`,
        )
        setTranscript(sid, result.entries)
        return
      }
      if (result.entries.length === 0) {
        // Nothing to apply -- but bump our lastAppliedSeq to server's lastSeq
        // so we stop asking. Happens if server advanced its counter without
        // net-new cached entries (e.g. all new entries got evicted between
        // sync_check and our fetch).
        useConversationsStore.setState(state => ({
          lastAppliedTranscriptSeq: { ...state.lastAppliedTranscriptSeq, [sid]: result.lastSeq },
        }))
        console.log(`[sync] REFETCH transcript ${sid.slice(0, 8)}: no new entries, bumped seq -> ${result.lastSeq}`)
        return
      }
      // Normal delta: append to existing transcript.
      useConversationsStore.setState(state => {
        const existing = state.transcripts[sid] || []
        // Guard: only append entries strictly newer than what we have.
        // Handles the race where a WS transcript_entries broadcast landed
        // between our sync_check send and this HTTP response.
        const localMax = state.lastAppliedTranscriptSeq[sid] ?? 0
        const fresh = result.entries.filter(e => (e.seq ?? 0) > localMax)
        if (fresh.length === 0) {
          return {
            lastAppliedTranscriptSeq: { ...state.lastAppliedTranscriptSeq, [sid]: Math.max(localMax, result.lastSeq) },
          }
        }
        console.log(
          `[sync] REFETCH transcript ${sid.slice(0, 8)}: +${fresh.length} delta entries (lastSeq ${localMax} -> ${result.lastSeq})`,
        )
        // Passive prune (live cap 100): mirror the WS broadcast path. The delta
        // is a real tail-grow, so the head may now exceed the cap. Evicted
        // entries flow into the page cache. Keep this in lockstep with
        // handleTranscriptEntries' prune logic; the LIVE_CAP constant lives
        // there to keep both call-sites aligned by import. ALSO suppressed
        // while state.scrollbackActive[sid] is true -- see the WS-broadcast
        // site for the user-yank rationale; deferred-collapse runs on
        // setScrollbackActive(sid, false) when the user returns to bottom.
        let merged = [...existing, ...fresh]
        const LIVE_CAP = 100
        const scrollback = state.scrollbackActive[sid]
        if (merged.length > LIVE_CAP && scrollback) {
          console.debug(
            `[transcript-prune] ${sid.slice(0, 8)} DEFERRED (scrollback active, delta refetch): live=${merged.length} > cap ${LIVE_CAP}`,
          )
        }
        if (merged.length > LIVE_CAP && !scrollback) {
          const t0 = performance.now()
          const dropCount = merged.length - LIVE_CAP
          const evicted = merged.slice(0, dropCount)
          merged = merged.slice(dropCount)
          cachePushEntries(sid, evicted)
          const elapsed = performance.now() - t0
          perfRecord(
            'transcript',
            'prune',
            elapsed,
            `${sid.slice(0, 8)} -${dropCount} (delta refetch, seq ${evicted[0]?.seq}..${evicted[evicted.length - 1]?.seq}); live=${merged.length}`,
          )
          console.debug(
            `[transcript-prune] ${sid.slice(0, 8)} dropped ${dropCount} entries via delta refetch (seq ${evicted[0]?.seq}..${evicted[evicted.length - 1]?.seq}); live=${merged.length} (cap ${LIVE_CAP}, ${elapsed.toFixed(1)}ms)`,
          )
        }
        return {
          transcripts: { ...state.transcripts, [sid]: merged },
          lastAppliedTranscriptSeq: { ...state.lastAppliedTranscriptSeq, [sid]: result.lastSeq },
          newDataSeq: state.newDataSeq + 1,
        }
      })
    })
  }
}

function processMessage(msg: DashboardMessage) {
  // All sync responses may carry staleTranscripts - handle once before type-specific logic
  const syncMsg = msg as DashboardMessage & { staleTranscripts?: Record<string, number> }
  if (syncMsg.staleTranscripts) refetchStaleTranscripts(syncMsg.staleTranscripts)

  const handler = handlers[msg.type]
  if (handler) handler(msg)
}

function scheduleFlush() {
  if (!rafScheduled) {
    rafScheduled = true
    requestAnimationFrame(flushMessages)
  }
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tracked send: serializes + records byte count. Uses wsRef for subscription watchers.
  function send(msg: Record<string, unknown>) {
    const w = wsRef.current
    if (!w || w.readyState !== WebSocket.OPEN) return
    const json = JSON.stringify(msg)
    recordOut(json.length)
    w.send(json)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: send is a module-scope function, not a React dep
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    try {
      const ws = new WebSocket(getWsUrl())
      wsRef.current = ws

      ws.onopen = () => {
        send({ type: 'subscribe', protocolVersion: 2 })

        // Single batched setState for ALL onopen state changes.
        // Multiple separate setState calls fire Zustand subscribers individually,
        // causing useSyncExternalStore tearing detection to loop (React #310).
        const { selectedConversationId, transcripts, events, connectSeq } = useConversationsStore.getState()

        // Evict stale conversations from LIFO cache (non-selected conversations may have missed WS entries)
        const evictedSids = Object.keys(transcripts).filter(sid => sid !== selectedConversationId)
        let newTranscripts = transcripts
        let newEvents = events
        if (evictedSids.length > 0) {
          newTranscripts = { ...transcripts }
          newEvents = { ...events }
          for (const sid of evictedSids) {
            delete newTranscripts[sid]
            delete newEvents[sid]
          }
          console.log(`[sync] reconnect: evicted ${evictedSids.length} stale conversations from LIFO cache`)
        }

        // ONE setState call instead of 5 separate ones
        useConversationsStore.setState({
          isConnected: true,
          error: null,
          ws,
          transcripts: newTranscripts,
          events: newEvents,
          connectSeq: connectSeq + 1,
        })

        // Reset subscription tracking - only current conversation
        clearSubscribedConversations()

        // Subscribe current conversation immediately
        if (selectedConversationId) {
          for (const ch of CONVERSATION_CHANNELS) {
            send({ type: 'channel_subscribe', channel: ch, conversationId: selectedConversationId })
          }
          _subscribedConversations.add(selectedConversationId)
        }

        // Re-send channel_subscribe for every held agent scope. The broker forgot
        // our subscriptions across the drop, but the refcounts still describe what
        // the client is showing (selected agent view + any future PiP tiles). Goes
        // through the seam so counts are preserved. `selectedSubagentId` is implied
        // by a held scope, so this subsumes the old single-agent re-subscribe.
        resubscribeAgentScopes(send)

        // Sync check after re-subscribing: detect transcript entries missed during
        // the disconnect gap (between subscribe and channel_subscribe, or entries
        // that arrived while WS was down). Small delay lets server process the
        // channel subscriptions first so the sync_check response is accurate.
        setTimeout(() => {
          // sync_check sends the last applied transcript seq per conversation, not
          // entry counts. Server compares against its own lastAssignedSeq per
          // conversation and replies with a delta list if we're behind.
          const { syncEpoch, syncSeq, lastAppliedTranscriptSeq } = useConversationsStore.getState()
          const transcriptSeqs: Record<string, number> = {}
          for (const [sid, seq] of Object.entries(lastAppliedTranscriptSeq)) {
            if (seq > 0) transcriptSeqs[sid] = seq
          }
          if (Object.keys(transcriptSeqs).length > 0) {
            const summary = Object.entries(transcriptSeqs)
              .map(([sid, s]) => `${sid.slice(0, 8)}@${s}`)
              .join(' ')
            console.log(
              `[sync] -> sync_check (reconnect) epoch=${syncEpoch.slice(0, 8)} seq=${syncSeq} transcriptSeqs=[${summary}]`,
            )
            send({ type: 'sync_check', epoch: syncEpoch, lastSeq: syncSeq, transcripts: transcriptSeqs })
          } else {
            console.log(`[sync] -> sync_check SKIP (reconnect): no tracked transcript seqs to compare`)
          }
        }, 500)
      }

      ws.onclose = e => {
        wsRef.current = null

        if (e.code === 1008 || e.code === 4401) {
          // Auth failure - don't reconnect, show expiry modal
          useConversationsStore.setState({
            isConnected: false,
            ws: null,
            authExpired: true,
            error: 'Conversation expired or unauthorized',
          })
          return
        }
        // Single setState for disconnect state
        useConversationsStore.setState({
          isConnected: false,
          ws: null,
          ...(e.code !== 1000 ? { error: `WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ''})` } : {}),
        })

        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null
            connect()
          }, RECONNECT_DELAY_MS)
        }
      }

      ws.onerror = () => {
        useConversationsStore.setState({ error: `WebSocket connection failed: ${getWsUrl()}` })
      }

      ws.onmessage = event => {
        const raw = event.data as string
        recordIn(raw.length)
        const wsT0 = isPerfEnabled() ? performance.now() : 0
        let msg: DashboardMessage | undefined
        try {
          msg = JSON.parse(raw) as DashboardMessage

          // --- Bypass buffer: latency-sensitive handlers ---

          // rclaude config responses -> promise resolution
          if (msg.type === 'rclaude_config_data' || msg.type === 'rclaude_config_ok') {
            resolveConfigResponse(msg as unknown as Record<string, unknown>)
            return
          }

          // Project board messages -> direct handler callback. The sentinel-backed
          // path replies with `project_*_result` (board ops + file reads); the
          // legacy agent-host path used `project_*_response`. `project_changed` is
          // the live broadcast. Route them all to the project handler.
          if (
            typeof msg.type === 'string' &&
            ((msg.type.startsWith('project_') && (msg.type.endsWith('_result') || msg.type.endsWith('_response'))) ||
              msg.type === 'project_changed')
          ) {
            const handler = useConversationsStore.getState().projectHandler
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Terminal data -> direct handler callback (low latency critical)
          if (msg.type === 'terminal_data' || msg.type === 'terminal_error') {
            const handler = useConversationsStore.getState().terminalHandler
            handler?.({
              type: msg.type as 'terminal_data' | 'terminal_error',
              conversationId: (msg as DashboardMessage & { conversationId?: string }).conversationId || '',
              data: msg.data,
              error: msg.error,
            })
            return
          }

          // Host-shell PTY bytes -> direct per-shell handler (low latency, like
          // terminal_data). Replay clears+repaints; data streams live. Routed by
          // shellId so N shell panes can stream concurrently.
          if (msg.type === 'shell_data' || msg.type === 'shell_replay') {
            dispatchShellData({
              type: msg.type,
              shellId: (msg as DashboardMessage & { shellId?: string }).shellId || '',
              data: msg.data || '',
              done: (msg as DashboardMessage & { done?: boolean }).done,
            })
            return
          }

          // JSON stream data -> direct handler callback (raw NDJSON for headless conversations)
          if (msg.type === 'json_stream_data') {
            const handler = useConversationsStore.getState().jsonStreamHandler
            handler?.({
              type: 'json_stream_data',
              conversationId: (msg as DashboardMessage & { conversationId?: string }).conversationId || '',
              lines: (msg as DashboardMessage & { lines?: string[] }).lines || [],
              isBackfill: !!(msg as DashboardMessage & { isBackfill?: boolean }).isBackfill,
            })
            return
          }

          // Background task output -> direct handler
          if (msg.type === 'bg_task_output') {
            if (msg.taskId) {
              handleBgTaskOutputMessage({
                taskId: msg.taskId,
                data: msg.data || '',
                done: msg.done || false,
              })
            }
            return
          }

          // Agent host outdated: an old binary tried to connect and the broker
          // rejected it. Surface as a persistent warning toast so the user
          // notices even when the agent host's terminal isn't visible.
          if (msg.type === 'agent_host_outdated') {
            const project = (msg.project as string | null) || 'unknown project'
            const upgradeCommand = (msg.upgradeCommand as string) || ''
            const reason = (msg.reason as string) || 'Outdated wire protocol'
            window.dispatchEvent(
              new CustomEvent('rclaude-toast', {
                detail: {
                  title: 'Agent host upgrade required',
                  body: `${project}\n${reason}\n\nRun: ${upgradeCommand}`,
                  variant: 'warning',
                  persistent: true,
                  copyText: upgradeCommand,
                },
              }),
            )
            return
          }

          // Toast notifications -> direct DOM event + bell accumulation
          if (msg.type === 'toast') {
            const title = (msg.title as string) || 'Notification'
            const body = (msg.message as string) || ''
            window.dispatchEvent(
              new CustomEvent('rclaude-toast', {
                detail: {
                  title,
                  body,
                  conversationId: msg.conversationId,
                  taskId: msg.taskId,
                  variant: msg.variant,
                },
              }),
            )
            // Accumulate non-transient toasts into bell notifications
            if (msg.conversationId && !msg.variant) {
              const convId = msg.conversationId as string
              const store = useConversationsStore.getState()
              const isViewing = store.selectedConversationId === convId
              if (!isViewing) {
                useConversationsStore.setState(state => ({
                  notifications: [
                    ...state.notifications,
                    {
                      id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      conversationId: convId,
                      title,
                      message: body,
                      timestamp: Date.now(),
                    },
                  ],
                }))
              }
            }
            return
          }

          // --- Buffer: state-updating messages ---
          msgBuffer.push(msg)
          scheduleFlush()
        } catch {
          // Ignore parse errors
        } finally {
          if (wsT0) {
            const t = (msg as { type?: string } | undefined)?.type ?? 'parse-error'
            perfRecord('ws', 'onmessage', performance.now() - wsT0, `${(raw.length / 1024).toFixed(1)}KB ${t}`)
          }
        }
      }
    } catch {
      useConversationsStore.setState({ isConnected: false })
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on mount, send is a module-scope function
  // react-doctor-disable-next-line react-doctor/exhaustive-deps
  useEffect(() => {
    connect()

    // Watch for conversation selection changes and manage channel subscriptions
    // Diff-based: keep subscriptions alive for LIFO-cached conversations
    // Uses selector-based subscribe to only fire when selectedConversationId or transcript keys change
    _subscribedConversations = new Set<string>()
    let _lastSelectedId: string | null = null
    let _lastTranscriptKeys: string = ''
    const unsubConversation = useConversationsStore.subscribe(state => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return

      // Quick check: bail if nothing subscription-relevant changed
      const transcriptKeys = Object.keys(state.transcripts).sort().join(',')
      if (state.selectedConversationId === _lastSelectedId && transcriptKeys === _lastTranscriptKeys) return
      _lastSelectedId = state.selectedConversationId
      _lastTranscriptKeys = transcriptKeys

      // Desired subscriptions: selected + all conversations with cached transcripts
      const desired = new Set<string>()
      if (state.selectedConversationId) desired.add(state.selectedConversationId)
      for (const sid of Object.keys(state.transcripts)) {
        if (state.transcripts[sid]?.length) desired.add(sid)
      }

      // Unsubscribe conversations no longer in cache
      for (const sid of _subscribedConversations) {
        if (!desired.has(sid)) {
          for (const ch of CONVERSATION_CHANNELS) {
            send({ type: 'channel_unsubscribe', channel: ch, conversationId: sid })
          }
        }
      }
      // Subscribe new conversation
      for (const sid of desired) {
        if (!_subscribedConversations.has(sid)) {
          for (const ch of CONVERSATION_CHANNELS) {
            send({ type: 'channel_subscribe', channel: ch, conversationId: sid })
          }
        }
      }
      _subscribedConversations = desired
    })

    // Watch for the selected-agent view (open/close) and acquire/release its
    // transcript scope through the refcounted seam. Releasing the previous scope
    // and acquiring the next on the same tick is the open/close race the seam's
    // refcounting absorbs -- a future PiP tile holding the same scope keeps it
    // alive across a detail-view close. Tracks the previous scope's PARTS (not a
    // joined key) so an agentId containing ':' round-trips cleanly.
    let prevScope: { conversationId: string; agentId: string } | null = null
    const unsubAgent = useConversationsStore.subscribe(state => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      const conversationId = state.selectedConversationId
      const agentId = state.selectedSubagentId
      const next = conversationId && agentId ? { conversationId, agentId } : null

      const same =
        next && prevScope && next.conversationId === prevScope.conversationId && next.agentId === prevScope.agentId
      if (same || (!next && !prevScope)) return

      if (prevScope) unsubscribeAgentScope(send, prevScope.conversationId, prevScope.agentId)
      if (next) subscribeAgentScope(send, next.conversationId, next.agentId)
      prevScope = next
    })

    // Periodic sync check: detect silently dropped transcript entries.
    // Runs every 60s while connected. Sends per-conversation lastAppliedSeq so the
    // server can report back any conversation where its counter has advanced past
    // what we've applied -- those get a ?sinceSeq=N delta refetch.
    const syncInterval = setInterval(() => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
      const { syncEpoch, syncSeq, lastAppliedTranscriptSeq } = useConversationsStore.getState()
      const transcriptSeqs: Record<string, number> = {}
      for (const [sid, seq] of Object.entries(lastAppliedTranscriptSeq)) {
        if (seq > 0) transcriptSeqs[sid] = seq
      }
      if (Object.keys(transcriptSeqs).length > 0) {
        const summary = Object.entries(transcriptSeqs)
          .map(([sid, s]) => `${sid.slice(0, 8)}@${s}`)
          .join(' ')
        console.log(
          `[sync] -> sync_check (periodic) epoch=${syncEpoch.slice(0, 8)} seq=${syncSeq} transcriptSeqs=[${summary}]`,
        )
        send({ type: 'sync_check', epoch: syncEpoch, lastSeq: syncSeq, transcripts: transcriptSeqs })
      }
    }, 60_000)

    return () => {
      unsubConversation()
      unsubAgent()
      clearInterval(syncInterval)
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [connect])

  return {
    isConnected: wsRef.current?.readyState === WebSocket.OPEN,
  }
}
