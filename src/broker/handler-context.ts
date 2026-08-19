/**
 * Handler context: passed to every WS message handler.
 * Provides access to conversation state, utilities, and the calling connection.
 */

import type { ServerWebSocket } from 'bun'
import type { ConnectionId, ConversationId } from '../shared/identity'
import type { CanvasShareTier, ProjectSettings } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import type { Permission, UserGrant } from './permissions'
import type { StoreDriver } from './store/types'

export interface WsData {
  ccSessionId?: string
  conversationId?: ConversationId
  connectionId?: ConnectionId
  isControlPanel?: boolean
  isSentinel?: boolean
  sentinelId?: string
  sentinelAlias?: string
  /** The registry id the BROKER filed this sentinel under, stamped at
   *  `sentinel_identify`. Equals `sentinelId` when an `snt_` secret proved the
   *  identity at upgrade; for the shared-admin-secret path -- which carries no
   *  `sentinelId` at all -- it is the registry's default sentinel record, the
   *  same id the spawn roster already uses.
   *
   *  Separate from `sentinelId` on purpose: that field means "a per-sentinel
   *  secret proved this", and daemon attribution plus the alias resolution read
   *  it. This one answers "who did the broker decide you are", which is a
   *  weaker claim and must not be mistaken for the stronger one. */
  resolvedSentinelId?: string
  /** Set at WS upgrade from an `rpt_` secret. Its PRESENCE is the whole reporter
   *  role: `detectRole` checks it first and unconditionally, so an `rpt_` socket
   *  can never be shadowed into a more capable role. A reporter never gets a
   *  `sentinelId` and therefore never enters the spawn roster. */
  reporterId?: string
  reporterAlias?: string
  /** One-shot latch: the node-stats handler logs its credential-stamping line
   *  once per connection rather than on every 5s frame. */
  nodeStatsIdentityLogged?: boolean
  /** One-shot latch for the sibling case: a node-stats frame REFUSED for want of
   *  a credential. Same 5s cadence, same reason to say it once. */
  nodeStatsRejectLogged?: boolean
  /** Dedicated host-shell DATA socket (sentinel -> broker byte pipe). Tagged at
   *  upgrade from the `?shellData=1` query flag. detectRole treats it as the
   *  sentinel role so `shell_data`/`shell_replay` route correctly. */
  isShellData?: boolean
  /** machineId of the sentinel that owns this shell-data socket (the pairing key
   *  back to the control connection). From `?shellDataSentinel=<machineId>`. */
  shellDataMachineId?: string
  userName?: string
  authToken?: string
  grants?: UserGrant[]
  /** Commit-ledger subscription tier for this socket. Absent/`counts` = the
   *  pill-sized `commit_count` frames only; `full` opts into whole commit rows
   *  (message + every touched path), which only a surface that renders them
   *  should ask for. See commit-ledger/broadcast.ts. */
  commitMode?: 'counts' | 'full'
  // Share (guest) access
  isShare?: boolean
  shareToken?: string
  /** When set, the share is scoped to a single conversation. The guest may
   *  only see/access this conversation, never the rest of the project. */
  shareConversationId?: string
  /** When set, the share is scoped to a single CANVAS -- the guest may join that
   *  canvas's multiplayer room and nothing else. Mirrors shareConversationId's
   *  "a share bound to A never grants B" rule. */
  shareCanvasId?: string
  /** Write ceiling for a canvas-share guest, resolved from the token at upgrade
   *  and never re-read from the wire. */
  shareCanvasTier?: CanvasShareTier
  hideUserInput?: boolean
  // Gateway adapter (e.g. Hermes)
  isGateway?: boolean
  gatewayType?: string
  gatewayId?: string
  gatewayAlias?: string
  // Live connection registry metadata (set at upgrade, not per-conversation)
  wsConnId?: string
  connectedAt?: number
  remoteAddr?: string
  userAgent?: string
}

/** Thrown by guard methods (requireBenevolent, requireAgent, etc.) */
export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

export interface HandlerContext {
  /** The WebSocket connection that sent this message */
  ws: ServerWebSocket<WsData>
  /** Conversation store (read/write conversation state) */
  conversations: ConversationStore
  /** Unified StoreDriver (SQLite-backed domain stores: costs, kv, transcripts, etc.) */
  store: StoreDriver
  /** Resolved caller conversation (from ws.data.conversationId) */
  caller?: ReturnType<ConversationStore['getConversation']>
  /** Caller's project settings */
  callerSettings?: ProjectSettings | null
  /** Verbose logging flag */
  verbose: boolean

  /** Send a JSON response back to the caller */
  reply(msg: Record<string, unknown>): void
  /** Broadcast a JSON message to all dashboard subscribers */
  broadcast(msg: Record<string, unknown>): void
  /** Broadcast a JSON message only to subscribers with chat:read for the given project */
  broadcastScoped(msg: Record<string, unknown>, project: string): void
  /** Web push notifications */
  push: {
    configured: boolean
    sendToAll(payload: {
      title: string
      body: string
      conversationId?: string
      project?: string
      tag?: string
      data?: Record<string, unknown>
    }): void
  }
  /** WebAuthn origins (for meta ack) */
  origins: string[]
  /** Get the sentinel WebSocket (if connected) */
  getSentinel(): ServerWebSocket<unknown> | undefined
  /** Get persisted links for a project */
  getLinksForProject(project: string): Array<{ projectA: string; projectB: string }>
  /** Get project settings for a project */
  getProjectSettings(project: string): ProjectSettings | null
  /** Set project settings for a project */
  setProjectSettings(project: string, update: Partial<ProjectSettings>): void
  /** Get all project settings */
  getAllProjectSettings(): Record<string, ProjectSettings>

  /** Contextual logger -- auto-prefixes with session/agent host info */
  log: {
    info(msg: string): void
    error(msg: string, err?: unknown): void
    debug(msg: string): void
  }

  /** Persisted link operations (project-pair based, survives restarts) */
  links: {
    find(projectA: string, projectB: string): boolean
    add(projectA: string, projectB: string): void
    remove(projectA: string, projectB: string): void
    touch(projectA: string, projectB: string): void
  }
  /**
   * Persisted conversation-pair link operations (survives restarts). Narrower than
   * `links`: a conv link authorizes messaging between exactly two conversations, not
   * their whole projects. Created by the `:` ad-hoc grant (channel_link_grant).
   */
  convLinks: {
    find(convA: string, convB: string): boolean
    add(convA: string, convB: string): void
    remove(convA: string, convB: string): void
    touch(convA: string, convB: string): void
  }
  /** Log an inter-conversation message for history */
  logMessage(entry: {
    ts: number
    from: { conversationId: string; project: string; name: string }
    to: { conversationId: string; project: string; name: string }
    intent: string
    conversationId: string
    preview: string
    fullLength: number
  }): void

  /** Address book: per-caller stable routing IDs */
  addressBook: {
    getOrAssign(callerProject: string, targetProject: string, targetName: string): string
    resolve(callerProject: string, localId: string): string | undefined
  }
  /** Persistent message queue for offline delivery */
  messageQueue: {
    enqueue(
      targetProject: string,
      senderProject: string,
      senderName: string,
      message: Record<string, unknown>,
      targetName?: string,
    ): void
    drain(
      targetProject: string,
      conversationName?: string,
    ): Array<{
      ts: number
      senderProject: string
      senderName: string
      message: Record<string, unknown>
      targetName?: string
    }>
    getQueueSize(targetProject: string): number
  }

  /** Guard: throws GuardError if caller is not benevolent */
  requireBenevolent(): void
  /** Guard: throws GuardError if no sentinel connected */
  requireSentinel(): ServerWebSocket<unknown>
  /** Guard: throws GuardError if caller has no session */
  requireConversation(): NonNullable<ReturnType<ConversationStore['getConversation']>>
  /**
   * Guard: throws GuardError if dashboard user lacks the required permission
   * for the given project. Agent Hosts/sentinels bypass all permission checks.
   */
  requirePermission(permission: Permission, project?: string): void
}

// biome-ignore lint/suspicious/noExplicitAny: WS JSON data is untyped at the parse boundary
export type MessageData = Record<string, any>

export type MessageHandler = (ctx: HandlerContext, data: MessageData) => void | Promise<void>

/** Create a log prefix from WS connection data */
export function logPrefix(ws: { data: WsData }): string {
  const id = ws.data.conversationId?.slice(0, 8)
  // Reporters first: they carry no conversationId and no sentinel marker, so
  // without this every reporter line read `[unknown]`.
  if (ws.data.reporterId) return `[reporter:${ws.data.reporterAlias ?? ws.data.reporterId.slice(0, 8)}]`
  if (ws.data.isSentinel) return '[sentinel]'
  if (ws.data.isControlPanel) return `[dash${ws.data.userName ? `:${ws.data.userName}` : ''}]`
  return id ? `[${id}]` : '[unknown]'
}
