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

import { beginMessage, endMessage, setFlushBatch } from '@/lib/perf-message-context'
import { isPerfEnabled, record as perfRecord } from '@/lib/perf-metrics'
import { buildWsUrl, isShareView } from '@/lib/share-mode'
import { addVoiceHistoryEntry } from '@/lib/voice-history'
import { handleWebControlRequest } from '@/lib/web-control-dispatch'
import { buildWebControlAdvertise } from '@/lib/web-control-grant'
import { resubscribeAgentScopes, subscribeAgentScope, unsubscribeAgentScope } from './agent-scope-subscription'
import { refetchStaleTranscripts } from './transcript-refetch'
import { handleBgTaskOutputMessage, resolveConfigResponse, useConversationsStore } from './use-conversations'
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
let syncCatchUpTimer: ReturnType<typeof setTimeout> | null = null

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
  // Credit the render this flush triggers to the batch's dominant message type
  // BEFORE batch() runs: unstable_batchedUpdates flushes its coalesced setState
  // synchronously at return, so the React commit (and its Profiler/render
  // records) fires while we're still inside flushMessages -- the tag has to be
  // live by then. The per-message sync span (beginMessage) takes precedence
  // inside the loop, then clears, leaving the batch tag for the commit.
  if (flushT0) setFlushBatch(dominantFlushType(pending))
  batch(() => {
    for (const msg of pending) {
      if (!flushT0) {
        processMessage(msg)
        continue
      }
      const type = (msg as { type?: string }).type ?? 'unknown'
      const t0 = performance.now()
      beginMessage(type)
      try {
        processMessage(msg)
      } finally {
        // Recorded while the span is still open, so the apply entry itself
        // carries msgType=type. This is handler compute only -- the Zustand
        // notify is deferred to batch() return (credited to the batch tag).
        perfRecord('message', `apply:${type}`, performance.now() - t0)
        endMessage()
      }
    }
  })
  if (flushT0) perfRecord('ws', 'flush', performance.now() - flushT0, summarizeFlush(pending))
  settleSyncCatchUp()
}

function settleSyncCatchUp() {
  if (!useConversationsStore.getState().syncCatchingUp) return
  if (syncCatchUpTimer) clearTimeout(syncCatchUpTimer)
  syncCatchUpTimer = setTimeout(() => {
    syncCatchUpTimer = null
    useConversationsStore.setState({ syncCatchingUp: false })
    console.log('[sync] catch-up settled')
  }, 1_000)
}

function flushTypeCounts(pending: DashboardMessage[]): Array<[string, number]> {
  const types: Record<string, number> = {}
  for (const msg of pending) {
    const t = (msg as { type?: string }).type ?? 'unknown'
    types[t] = (types[t] ?? 0) + 1
  }
  return Object.entries(types).sort((a, b) => b[1] - a[1])
}

function summarizeFlush(pending: DashboardMessage[]): string {
  const detail = flushTypeCounts(pending)
    .map(([t, n]) => (n === 1 ? t : `${t}x${n}`))
    .join(',')
  return `n=${pending.length} ${detail}`
}

// The single message type that most drove this flush -- the render attribution
// key. A pure-streaming batch (all transcript_entries) is exact; a mixed batch
// credits its render cost to the heaviest contributor (documented approximation
// in perf-message-context). Full composition stays visible in the 'flush' entry.
function dominantFlushType(pending: DashboardMessage[]): string {
  return flushTypeCounts(pending)[0]?.[0] ?? 'unknown'
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

/**
 * @param opts.conversationChannels When false, this socket NEVER subscribes to
 *   conversation transcript/events/tasks/bg_output channels. Standalone surfaces
 *   like the canvas popout only need the `canvas` channel, and pulling a busy
 *   conversation's multi-KB transcript entries would balloon the socket's send
 *   buffer into backpressure (megabytes), starving the canvas broadcasts that
 *   share it. Defaults true (the full dashboard).
 */
export function useWebSocket(opts?: { conversationChannels?: boolean }) {
  const subscribeConvChannels = opts?.conversationChannels !== false
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

        // Subscribe current conversation immediately (skipped on a canvas-only socket).
        if (subscribeConvChannels && selectedConversationId) {
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

        // Re-advertise the web debug-control grant if one is active. The grant
        // lives in localStorage so it survives full reload / SW update; on every
        // (re)connect we re-announce the SAME stable clientId so the agent keeps
        // targeting this browser across socket churn. No grant -> no advertise
        // (default-deny: the broker never targets a browser it can't see).
        const advertise = buildWebControlAdvertise()
        if (advertise) send({ type: 'web_control_advertise', ...advertise })

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

      const scheduleReconnect = () => {
        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null
            connect()
          }, RECONNECT_DELAY_MS)
        }
      }

      // An "auth-coded" WS close (4401 from the broker, or a 1008 injected by a
      // proxy / idle-timeout) is NOT trustworthy proof the session is dead. The
      // broker bounces sockets on transient conditions too, and the user's own
      // manual refresh almost always recovers -- which means the cookie is still
      // valid. So before locking the user out behind the SESSION EXPIRED modal,
      // prove auth state with a real authed request, exactly what a refresh does.
      // /auth/status is public (never 401s), reports { authenticated }, AND
      // silently renews the cookie, so a healthy session self-heals instead of
      // dead-ending. One retry covers a brief revoke/reload race on the broker.
      const verifyAuthThenReconnect = async (code: number, reason: string) => {
        // Share-link guests authenticate with the share token, not a cookie, so
        // /auth/status would falsely report unauthenticated. Just reconnect.
        if (isShareView()) {
          scheduleReconnect()
          return
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 1500))
          try {
            const res = await fetch('/auth/status', { credentials: 'include', cache: 'no-store' })
            const data = (await res.json()) as { authenticated?: boolean }
            if (data?.authenticated) {
              console.warn(
                `[ws] close code=${code}${reason ? ` reason=${reason}` : ''} looked auth-fatal but /auth/status=authenticated -> transient, reconnecting`,
              )
              scheduleReconnect()
              return
            }
          } catch (err) {
            // Probe itself failed (network down) -> not proof of expiry. Reconnect.
            console.warn(
              `[ws] auth probe failed (${String(err)}) -> treating close code=${code} as transient, reconnecting`,
            )
            scheduleReconnect()
            return
          }
        }
        // Probe consistently says unauthenticated -> genuine expiry/revoke. Lock down.
        console.warn(`[ws] close code=${code} confirmed unauthenticated by /auth/status -> session expired`)
        useConversationsStore.setState({ authExpired: true, error: 'Session expired' })
      }

      ws.onclose = e => {
        wsRef.current = null

        // Single setState for disconnect state (regardless of why we closed)
        useConversationsStore.setState({
          isConnected: false,
          ws: null,
          ...(e.code !== 1000 ? { error: `WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ''})` } : {}),
        })

        if (e.code === 1008 || e.code === 4401) {
          // Looks like auth death -- but verify before showing the modal. Never
          // trust the close code alone (backpressure now uses 4290, but proxies
          // still inject 1008, and a 4401 can fire on a transient broker race).
          void verifyAuthThenReconnect(e.code, e.reason)
          return
        }

        scheduleReconnect()
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

          // Per-project checklist messages -> direct handler callback. Covers the
          // live `checklist_changed` broadcast and the request/reply results
          // (checklist_list_result, checklist_op_result, checklist_archive_result).
          if (typeof msg.type === 'string' && msg.type.startsWith('checklist_')) {
            const handler = useConversationsStore.getState().checklistHandler
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Canvas live-multiplayer (canvas_join_ack / presence / pointer /
          // scene_delta / error) -> canvas bus, dispatched by canvasId. High
          // frequency (cursors), so bypass the buffer like terminal data.
          if (typeof msg.type === 'string' && msg.type.startsWith('canvas_')) {
            useConversationsStore.getState().canvasHandler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Nightshift result + live event broadcast -> nightshift handler.
          if (typeof msg.type === 'string' && (msg.type === 'nightshift_result' || msg.type === 'nightshift_event')) {
            const handler = useConversationsStore.getState().nightshiftHandler
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Nightshift WATCHDOG decision log (backfill reply + live beat) -> Status screen.
          if (
            typeof msg.type === 'string' &&
            (msg.type === 'nightshift_watchdog_result' || msg.type === 'nightshift_watchdog_event')
          ) {
            const handler = useConversationsStore.getState().nightshiftWatchdogHandler
            handler?.(msg as unknown as Record<string, unknown>)
            return
          }

          // Recovered voice result (redelivered after WS reconnect) -> persist
          // to localStorage history. The voice recording hook only listens
          // during active recording; this global handler catches results
          // that arrive on subscribe (reconnect).
          if (msg.type === 'voice_done' && (msg as { recovered?: boolean }).recovered) {
            const m = msg as { raw?: string; refined?: string }
            if (m.raw || m.refined) {
              console.log('[voice] Recovered voice result from broker (buffered during WS disconnect)')
              addVoiceHistoryEntry({
                raw: m.raw || '',
                refined: m.refined || '',
                conversationId: null,
                recovered: true,
              })
            }
            // Don't return -- let it also reach any active voice recording listener
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
                useConversationsStore.setState(state => {
                  const now = Date.now()
                  const NOTIFICATIONS_CAP = 100
                  const NOTIFICATIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000
                  const next = [
                    ...state.notifications.filter(n => now - n.timestamp < NOTIFICATIONS_MAX_AGE_MS),
                    {
                      id: `toast-${now}-${Math.random().toString(36).slice(2, 8)}`,
                      conversationId: convId,
                      title,
                      message: body,
                      timestamp: now,
                    },
                  ]
                  return {
                    notifications: next.length > NOTIFICATIONS_CAP ? next.slice(-NOTIFICATIONS_CAP) : next,
                  }
                })
              }
            }
            return
          }

          // Web debug-control request -> execute in this browser, reply async.
          // Bypass the buffer: it is a self-contained command/response, not a
          // state-update that the transcript renderer needs to batch.
          if (msg.type === 'web_control_request') {
            void handleWebControlRequest(msg as unknown as Parameters<typeof handleWebControlRequest>[0], send)
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

  // react-doctor-disable-next-line react-doctor/exhaustive-deps
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional - runs once on mount, send is a module-scope function
  useEffect(() => {
    connect()

    // Watch for conversation selection changes and manage channel subscriptions
    // Diff-based: keep subscriptions alive for LIFO-cached conversations
    // Uses selector-based subscribe to only fire when selectedConversationId or transcript keys change
    _subscribedConversations = new Set<string>()
    let _lastSelectedId: string | null = null
    let _lastTranscriptKeys: string = ''
    const unsubConversation = useConversationsStore.subscribe(state => {
      // Canvas-only sockets never manage conversation-channel subscriptions.
      if (!subscribeConvChannels) return
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
      // Skip while hidden: responses pile up and all flush on tab restore,
      // causing a connectSeq storm (each sync_stale bumps connectSeq ->
      // full reconnect cycle x N). The visibility-restore handler sends
      // its own sync_check, so nothing is lost.
      if (document.hidden) return
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
