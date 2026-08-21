/**
 * Buffer bypass: messages that must NOT wait for the next frame.
 *
 * Everything here is either latency-critical (terminal bytes, PTY bytes, cursor
 * traffic) or a command/response that no renderer needs batched (config replies,
 * board results). Each route hands the payload to a listener that owns it -- a
 * store-held handler callback or a dedicated bus -- and returns true to say the
 * message is fully dealt with. Returning false drops it into the rAF buffer.
 *
 * Order is the wire's order: the pong first, because a latency sample that
 * waits behind anything at all reports the wait.
 */

import { WS_PONG, type WsPongMessage } from '@shared/ws-probe'
import { isCanvasChatMessage } from '@/components/canvas/canvas-chat-bus'
import { addVoiceHistoryEntry } from '@/lib/voice-history'
import { handleBgTaskOutputMessage, resolveConfigResponse, useConversationsStore } from './use-conversations'
import { dispatchShellData } from './use-shells'
import type { DashboardMessage } from './use-websocket-handlers'
import { recordPong } from './ws-rtt'

type ConversationsState = ReturnType<typeof useConversationsStore.getState>
type StoreHandler = ((msg: Record<string, unknown>) => void) | null

/** True when this message was dispatched off the buffer and needs no further routing. */
export function routeBypassMessage(msg: DashboardMessage): boolean {
  // The round-trip probe's echo. FIRST, and bypassing the rAF buffer for
  // the obvious reason: a latency sample that waits for the next frame
  // has a frame of jitter baked into the number it reports.
  if (msg.type === WS_PONG) {
    recordPong((msg as unknown as WsPongMessage).token)
    return true
  }

  // rclaude config responses -> promise resolution
  if (msg.type === 'rclaude_config_data' || msg.type === 'rclaude_config_ok') {
    resolveConfigResponse(msg as unknown as Record<string, unknown>)
    return true
  }

  if (routeToStoreHandler(msg)) return true
  if (routeTerminalBytes(msg)) return true
  if (routeTaskStreams(msg)) return true

  // Recovered voice result (redelivered after WS reconnect) -> persist
  // to localStorage history. The voice recording hook only listens
  // during active recording; this global handler catches results
  // that arrive on subscribe (reconnect).
  if (msg.type === 'voice_done' && (msg as { recovered?: boolean }).recovered) {
    recordRecoveredVoice(msg)
    // Don't return -- let it also reach any active voice recording listener
  }

  return false
}

/**
 * Routes whose listener is a callback parked in the conversations store by
 * whichever panel is currently mounted. A table rather than a chain of `if`s,
 * for the same reason the message handlers next door are one: the ROUTING is
 * the interesting part, and it should be readable as a list.
 *
 * No listener -> the message is still consumed: the panel is closed, and
 * buffering it would only replay it late.
 */
const STORE_HANDLER_ROUTES: Array<{ match: (type: string) => boolean; pick: (s: ConversationsState) => StoreHandler }> =
  [
    // Project board messages. The sentinel-backed path replies with
    // `project_*_result` (board ops + file reads); the legacy agent-host path
    // used `project_*_response`. `project_changed` is the live broadcast.
    { match: isProjectMessage, pick: s => s.projectHandler },

    // (No card-ledger route here on purpose. Card moves reach the panel inside
    // the `wall` frame -- ring on subscribe, deltas after -- so the wall is ONE
    // subscription rather than one plus a private route.)

    // Per-project checklist: the live `checklist_changed` broadcast and the
    // request/reply results (list, op, archive).
    { match: type => type.startsWith('checklist_'), pick: s => s.checklistHandler },

    // Canvas CHAT (chat_message / connect_result / send_result) -> its own bus.
    // Split from the collab bus below because the chat panel mounts and
    // unmounts independently of the room: sharing one listener slot would let
    // closing the chat take the room's cursors with it.
    { match: isCanvasChatMessage, pick: s => s.canvasChatHandler },

    // Canvas live-multiplayer (canvas_join_ack / presence / pointer /
    // scene_delta / error), dispatched by canvasId. High frequency (cursors),
    // so bypass the buffer like terminal data.
    { match: type => type.startsWith('canvas_'), pick: s => s.canvasHandler },

    // Nightshift result + live event broadcast.
    { match: type => type === 'nightshift_result' || type === 'nightshift_event', pick: s => s.nightshiftHandler },

    // Nightshift WATCHDOG decision log (backfill reply + live beat) -> Status screen.
    {
      match: type => type === 'nightshift_watchdog_result' || type === 'nightshift_watchdog_event',
      pick: s => s.nightshiftWatchdogHandler,
    },

    // THE MORNING REPORT: the request/reply for `latest` and `execute`, plus the
    // `board_report_changed` push. The push is why this is a route rather than a
    // bare request channel -- a PARKED surface has to learn that the morning's
    // brew landed, or its dock tile can never pulse.
    {
      match: type => type === 'board_report_result' || type === 'board_report_changed',
      pick: s => s.boardReportHandler,
    },
  ]

function isProjectMessage(type: string): boolean {
  if (type === 'project_changed') return true
  if (!type.startsWith('project_')) return false
  return type.endsWith('_result') || type.endsWith('_response')
}

function routeToStoreHandler(msg: DashboardMessage): boolean {
  const type = msg.type
  if (typeof type !== 'string') return false
  const route = STORE_HANDLER_ROUTES.find(r => r.match(type))
  if (!route) return false
  route.pick(useConversationsStore.getState())?.(msg as unknown as Record<string, unknown>)
  return true
}

/** Terminal + host-shell bytes: the two low-latency PTY streams. */
function routeTerminalBytes(msg: DashboardMessage): boolean {
  // Terminal data -> direct handler callback (low latency critical)
  if (msg.type === 'terminal_data' || msg.type === 'terminal_error') {
    const handler = useConversationsStore.getState().terminalHandler
    handler?.({
      type: msg.type as 'terminal_data' | 'terminal_error',
      conversationId: field<string>(msg, 'conversationId') || '',
      data: msg.data,
      error: msg.error,
    })
    return true
  }

  // Host-shell PTY bytes -> direct per-shell handler (low latency, like
  // terminal_data). Replay clears+repaints; data streams live. Routed by
  // shellId so N shell panes can stream concurrently.
  if (msg.type === 'shell_data' || msg.type === 'shell_replay') {
    dispatchShellData({
      type: msg.type,
      shellId: field<string>(msg, 'shellId') || '',
      data: msg.data || '',
      done: field<boolean>(msg, 'done'),
    })
    return true
  }

  return false
}

/** Raw NDJSON for headless conversations, and background task output. */
function routeTaskStreams(msg: DashboardMessage): boolean {
  // JSON stream data -> direct handler callback
  if (msg.type === 'json_stream_data') {
    const handler = useConversationsStore.getState().jsonStreamHandler
    handler?.({
      type: 'json_stream_data',
      conversationId: field<string>(msg, 'conversationId') || '',
      lines: field<string[]>(msg, 'lines') || [],
      isBackfill: !!field<boolean>(msg, 'isBackfill'),
    })
    return true
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
    return true
  }

  return false
}

/** Read an off-contract field off a wire message without repeating the cast. */
function field<T>(msg: DashboardMessage, key: string): T | undefined {
  return (msg as DashboardMessage & Record<string, unknown>)[key] as T | undefined
}

function recordRecoveredVoice(msg: DashboardMessage) {
  const m = msg as { raw?: string; refined?: string }
  if (!m.raw && !m.refined) return
  console.log('[voice] Recovered voice result from broker (buffered during WS disconnect)')
  addVoiceHistoryEntry({
    raw: m.raw || '',
    refined: m.refined || '',
    conversationId: null,
    recovered: true,
  })
}
