import type { DialogOp, DialogSnapshot } from '../../../shared/dialog-live'
import type { DialogLayout, DialogResult } from '../../../shared/dialog-schema'
import type { LiveStatus, LiveStatusInput } from '../../../shared/protocol'
import type { SpawnRequest } from '../../../shared/spawn-schema'
import type { OpenDialogRegistry } from '../open-dialogs'

export type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

export interface ToolCtx {
  progressToken?: string | number
  rawArgs: unknown
  extra: unknown
}

export interface ToolDef {
  description: string
  inputSchema: unknown
  hidden?: boolean
  handle: (params: Record<string, string>, ctx: ToolCtx) => Promise<ToolResult>
}

export interface PendingDialog {
  resolve: (result: DialogResult) => void
  timer: ReturnType<typeof setTimeout>
  timeoutMs: number
  deadline: number
}

export interface ConversationInfo {
  id: string
  project?: string
  session_id?: string
  name: string
  /**
   * `spawning` rows are pre-boot synthetic entries surfaced from active spawn
   * jobs. The agent host hasn't connected yet; the row exists so callers can
   * see and address it (send_message will queue) without polling.
   */
  status: 'live' | 'inactive' | 'spawning'
  /** Marker on the caller's own row (minimal tier). */
  self?: true
  /** Sentinel alias when known. Omitted for non-sentinel backends. */
  host?: string
  /** Sentinel-profile name when set. Omitted for implicit default or
   *  backends without profile support. */
  profile?: string
  ccSessionIds?: string[]
  label?: string
  description?: string
  title?: string
  summary?: string
  /** THE STATUS — the conversation's last self-reported status (include: ['agent_status']). */
  agentStatus?: LiveStatus
  /** Relative age of the last status update (e.g. "3m"). With include: ['agent_status']. */
  statusAge?: string
  /** Relative age of the last impulse — message posted to the conversation (e.g. "12m"). */
  lastInputAge?: string
  /** Only set on `status: "spawning"` rows. The job that's bringing this up. */
  spawnJobId?: string
  /** Only set on `status: "spawning"` rows. Last lifecycle step observed. */
  spawnStep?: string
}

export interface AgentHostIdentity {
  ccSessionId: string
  conversationId: string
  cwd: string
  configuredModel?: string
  headless: boolean
  claudeVersion?: string
  claudeAuth?: { email?: string; orgId?: string; orgName?: string; subscriptionType?: string }
}

export interface PermissionRequestData {
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

export interface McpChannelCallbacks {
  onNotify?: (message: string, title?: string) => void
  /** THE STATUS — agent self-reported task state (set_status tool). */
  onSetStatus?: (status: LiveStatusInput) => void
  onShareFile?: (filePath: string) => Promise<{ url: string } | { error: string }>
  onListConversations?: (
    status?: string,
    showMetadata?: boolean,
    fields?: 'minimal' | 'standard' | 'full',
    include?: string[],
  ) => Promise<{
    conversations: ConversationInfo[]
    self?: Record<string, unknown>
    issues?: Array<{
      severity: 'error' | 'warning'
      code: string
      conversation_id?: string
      project?: string
      message: string
    }>
  }>
  onSendMessage?: (
    to: string | string[],
    intent: string,
    message: string,
    context?: string,
    conversationId?: string,
  ) => Promise<{
    ok: boolean
    error?: string
    conversationId?: string
    targetConversationId?: string
    status?: 'delivered' | 'queued'
    canonicalAddress?: string
    results?: Array<{
      to: string
      ok: boolean
      status?: 'delivered' | 'queued'
      targetConversationId?: string
      error?: string
      canonicalAddress?: string
    }>
  }>
  onPermissionRequest?: (data: PermissionRequestData) => void
  onDisconnect?: () => void
  onTogglePlanMode?: () => void
  onReviveConversation?: (conversationId: string) => Promise<{ ok: boolean; error?: string; name?: string }>
  onControlConversation?: (params: {
    conversationId: string
    action: 'clear' | 'quit' | 'interrupt' | 'set_model' | 'set_effort' | 'set_permission_mode' | 'cancel_background_task'
    model?: string
    effort?: string
    permissionMode?: string
    taskId?: string
  }) => Promise<{ ok: boolean; error?: string; name?: string }>
  onRestartConversation?: (conversationId: string) => Promise<{
    ok: boolean
    error?: string
    name?: string
    selfRestart?: boolean
    alreadyEnded?: boolean
  }>
  onSpawnConversation?: (
    params: Omit<SpawnRequest, 'jobId'> & {
      onProgress?: (event: Record<string, unknown>) => void
    },
  ) => Promise<{ ok: boolean; error?: string; conversationId?: string; jobId?: string }>
  onListHosts?: () => Promise<
    Array<{ alias: string; hostname?: string; connected: boolean; conversationCount: number }>
  >
  onGetSpawnDiagnostics?: (
    jobId: string,
  ) => Promise<{ ok: boolean; error?: string; diagnostics?: Record<string, unknown> }>
  onConfigureConversation?: (params: {
    conversationId: string
    label?: string
    icon?: string
    color?: string
    description?: string
    keyterms?: string[]
  }) => Promise<{ ok: boolean; error?: string }>
  onDialogShow?: (dialogId: string, layout: DialogLayout) => void
  // reason 'timeout'/'cancelled' keeps the dialog re-displayable (expired) on the
  // dashboard so the user can answer it late; omitted = hard dismiss (answered or
  // conversation ended).
  onDialogDismiss?: (dialogId: string, reason?: 'timeout' | 'cancelled') => void
  // THE DIALOGUE — live/persistent emits (host -> broker -> panel). Each carries
  // the host-authoritative snapshot the broker persists opaquely.
  onDialogPatch?: (
    dialogId: string,
    baseSeq: number,
    ops: DialogOp[],
    snapshot: DialogSnapshot,
    rationale?: string,
  ) => void
  onDialogReopen?: (dialogId: string, snapshot: DialogSnapshot) => void
  onDialogOrphaned?: (dialogId: string, reason: string, snapshot: DialogSnapshot) => void
  onDeliverMessage?: (content: string, meta: Record<string, string>) => void
  onRenameConversation?: (
    name: string,
    description?: string,
    targetConversationId?: string,
  ) => Promise<{ ok: boolean; error?: string }>
  onProjectChanged?: () => void
  onExitConversation?: (status: 'success' | 'error', message?: string) => void
}

export interface McpToolContext {
  callbacks: McpChannelCallbacks
  getIdentity: () => AgentHostIdentity | null
  getClaudeCodeVersion: () => string | undefined
  getDialogCwd: () => string
  pendingDialogs: Map<string, PendingDialog>
  /** Host-authoritative registry of live/persistent dialogs (THE DIALOGUE). */
  openDialogs: OpenDialogRegistry
  elog: (msg: string) => void
  // Broker access for HTTP-backed tools (search, etc). Optional so tests/headless
  // tools without a broker still work.
  brokerUrl?: string
  brokerSecret?: string
  noBroker?: boolean
}
