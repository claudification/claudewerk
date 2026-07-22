/**
 * Host-shell relay handlers (broker).
 *
 * Routes the three planes of plan-host-shell.md:
 *   - control (web -> sentinel control WS): `shell_open` / `shell_close`
 *   - control (sentinel control WS -> web roster): `shell_exit` / `shell_activity`
 *   - data    (web -> sentinel data WS): `shell_subscribe`/`shell_unsubscribe`
 *               drive `shell_attach`/`shell_detach`; `shell_input`/`shell_resize`
 *   - data    (sentinel data WS -> subscribed web): `shell_data` / `shell_replay`
 *
 * The broker owns the roster (`shell-registry.ts`) + the per-viewer min-size
 * policy; the sentinel owns the PTY. Routing keys are `projectUri` / `sentinelId`
 * / `shellId` ONLY -- never `ccSessionId` (BOUNDARY).
 *
 * Permission gates (mirror the terminal split, plan 4.2):
 *   - `terminal`      (write): open / input / close
 *   - `terminal:read` (read):  subscribe / resize-viewport + roster visibility
 */

import { basename } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { DEFAULT_SENTINEL_NAME, type ProjectUri, tryParseProjectUri } from '../../shared/project-uri'
import type { ShellOpen, ShellResyncEntry, ShellRosterEntry, TranscriptShellEntry } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import type { SentinelConnection } from '../conversation-store/sentinel'
import { GuardError, type HandlerContext, type MessageData, type MessageHandler } from '../handler-context'
import { registerHandlers, SENTINEL_ONLY, type WsRole } from '../message-router'
import type { Permission } from '../permissions'
import { type BrokerShell, type SubscribeAction, shellRegistry, type UnsubscribeAction } from '../shell-registry'
import { ingestAndBroadcast } from '../transcript-ingest'
import { deterministicUuid } from './transcript-uuid'

/** Raw shells are control-panel-only: a `$SHELL` PTY is RCE as the host user, so
 *  share-link guests never reach these handlers (they could otherwise dodge the
 *  `requirePermission` control-panel gate). */
const WEB_ONLY: WsRole[] = ['control-panel']

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Clamp a wire dimension to a sane positive integer. */
function dim(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

/** Resolve the live shell a wire frame targets (by shellId), perm-checked for the
 *  caller against the shell's URI. Undefined to bail (unknown shell). Throws
 *  GuardError when the caller lacks `perm` (router maps it to `*_result`). */
function requireShell(ctx: HandlerContext, data: MessageData, perm: Permission): BrokerShell | undefined {
  const shell = shellRegistry.get(str(data.shellId))
  if (!shell) return undefined
  ctx.requirePermission(perm, shell.entry.projectUri)
  return shell
}

/** Send a data-plane frame over the shell's owning sentinel's data socket. */
function sendData(shellId: string, msg: Record<string, unknown>): void {
  shellRegistry.dataSocketFor(shellId)?.send(JSON.stringify({ ...msg, shellId }))
}

/** First viewer -> attach+replay; min shrank -> resize; null/noop -> nothing. */
function applySubscribeAction(shellId: string, action: SubscribeAction | null): void {
  if (!action) return
  if (action.kind === 'attach')
    sendData(shellId, { type: 'shell_attach', cols: action.cols, rows: action.rows, replay: true })
  else if (action.kind === 'resize') sendData(shellId, { type: 'shell_resize', cols: action.cols, rows: action.rows })
}

/** Last viewer -> detach; min changed -> resize; null/noop -> nothing. */
function applyUnsubAction(shellId: string, action: UnsubscribeAction | null): void {
  if (!action) return
  if (action.kind === 'detach') sendData(shellId, { type: 'shell_detach' })
  else if (action.kind === 'resize') sendData(shellId, { type: 'shell_resize', cols: action.cols, rows: action.rows })
}

/** Fan a serialized frame to every current subscriber of a shell. */
function fanToSubscribers(shellId: string, json: string): void {
  for (const sub of shellRegistry.subscribers(shellId)) {
    try {
      sub.send(json)
    } catch {}
  }
}

/** Resolve the sentinel connection that owns a project URI by its authority (the
 *  sentinel alias), falling back to the default sentinel for the canonical
 *  `default` authority. Undefined when that sentinel is offline. */
function resolveSentinelConn(conversations: ConversationStore, authority?: string): SentinelConnection | undefined {
  const alias = authority || DEFAULT_SENTINEL_NAME
  const byAlias = conversations.getSentinelConnectionByAlias(alias)
  if (byAlias) return byAlias
  return alias === DEFAULT_SENTINEL_NAME ? conversations.getDefaultSentinelConnection() : undefined
}

/** Verify the sending shell-data socket actually owns the shell (machineId
 *  pairing) -- a sentinel must not inject into another sentinel's shell.
 *  Permissive when either id is unknown (legacy). */
function senderOwnsShell(ctx: HandlerContext, machineId?: string): boolean {
  const sender = ctx.ws.data.shellDataMachineId
  return !sender || !machineId || sender === machineId
}

/** Emit a `TranscriptShellEntry` receipt into the attached conversation (open /
 *  exit only; live bytes stay ephemeral -- plan 4.5). No-op when the
 *  conversation is unknown or none was attached. */
function emitShellReceipt(
  ctx: HandlerContext,
  conversationId: string,
  entry: ShellRosterEntry,
  event: 'open' | 'exit',
  code?: number,
): void {
  const conv =
    ctx.conversations.getConversation(conversationId) ??
    ctx.conversations.findConversationByConversationId(conversationId)
  if (!conv) return
  const detail = event === 'open' ? `opened ${entry.path}` : `exited (code ${code})`
  const tEntry: TranscriptShellEntry = {
    type: 'shell',
    shellId: entry.shellId,
    event,
    projectUri: entry.projectUri,
    path: entry.path,
    title: entry.title,
    createdBy: entry.createdBy,
    code,
    detail,
    timestamp: new Date().toISOString(),
    uuid: deterministicUuid(`${conv.id}:shell:${entry.shellId}:${event}`),
  }
  ingestAndBroadcast(ctx.conversations, conv.id, [tEntry])
}

interface OpenParams {
  projectUri: string
  shellId: string
  parsed: ProjectUri
  conn: SentinelConnection
  cols: number
  rows: number
  title: string
  createdBy: string
  conversationId?: string
}

/**
 * Validate + resolve a `shell_open` request, throwing GuardError on any rejection
 * (missing fields, bad URI, duplicate shellId, offline sentinel) + WRITE-gating
 * the URI. Concentrates the open path's validation + coercion so the handler body
 * stays branch-free. Branch count IS the validation surface, not hidden logic.
 */
// fallow-ignore-next-line complexity
function validateOpen(ctx: HandlerContext, data: MessageData): OpenParams {
  const projectUri = str(data.projectUri)
  const shellId = str(data.shellId)
  if (!projectUri || !shellId) throw new GuardError('shell_open requires projectUri + shellId')
  ctx.requirePermission('terminal', projectUri) // WRITE -- opening a raw shell is privileged.
  const parsed = tryParseProjectUri(projectUri)
  if (!parsed) throw new GuardError(`shell_open: invalid projectUri ${projectUri}`)
  if (shellRegistry.has(shellId)) throw new GuardError(`shell ${shellId} already exists`)
  const conn = resolveSentinelConn(ctx.conversations, parsed.authority)
  if (!conn) throw new GuardError(`No sentinel online for ${projectUri}`)
  return {
    projectUri,
    shellId,
    parsed,
    conn,
    cols: dim(data.cols, 80),
    rows: dim(data.rows, 24),
    title: str(data.title) || basename(parsed.path) || parsed.path,
    createdBy: ctx.ws.data.userName ?? 'unknown',
    conversationId: typeof data.conversationId === 'string' ? data.conversationId : undefined,
  }
}

// ── Control plane: web -> sentinel ───────────────────────────────────

const shellOpen: MessageHandler = (ctx, data) => {
  const p = validateOpen(ctx, data)
  // Optimistic roster: no sentinel ack exists. Built from the authorized open;
  // removed on shell_exit / sentinel-disconnect.
  const entry: ShellRosterEntry = {
    shellId: p.shellId,
    projectUri: p.projectUri,
    sentinelId: p.conn.sentinelId,
    path: p.parsed.path,
    title: p.title,
    status: 'live',
    createdBy: p.createdBy,
    createdAt: Date.now(),
  }
  shellRegistry.add(entry, { conversationId: p.conversationId, machineId: p.conn.machineId })
  p.conn.ws.send(
    JSON.stringify({
      type: 'shell_open',
      projectUri: p.projectUri,
      shellId: p.shellId,
      cols: p.cols,
      rows: p.rows,
      title: p.title,
      conversationId: p.conversationId,
    } satisfies ShellOpen),
  )
  ctx.conversations.broadcastShellScoped({ type: 'shell_added', shell: entry }, p.projectUri)
  if (p.conversationId) emitShellReceipt(ctx, p.conversationId, entry, 'open')
  ctx.log.info(
    `[shell] open ${p.shellId} uri=${p.projectUri} sentinel=${p.conn.sentinelId} by=${p.createdBy} (${p.cols}x${p.rows})`,
  )
}

const shellClose: MessageHandler = (ctx, data) => {
  const shell = requireShell(ctx, data, 'terminal') // WRITE -- killing a shell.
  if (!shell) return
  const conn = resolveSentinelConn(ctx.conversations, tryParseProjectUri(shell.entry.projectUri)?.authority)
  conn?.ws.send(JSON.stringify({ type: 'shell_close', shellId: shell.entry.shellId }))
  ctx.log.info(`[shell] close ${shell.entry.shellId} by=${ctx.ws.data.userName ?? 'unknown'}`)
  // Roster removal waits for the sentinel's authoritative shell_exit.
}

// ── Data plane: web -> sentinel (subscription drives attach/detach) ───

const shellSubscribe: MessageHandler = (ctx, data) => {
  const shell = requireShell(ctx, data, 'terminal:read') // READ -- watching bytes.
  if (!shell) return
  const id = shell.entry.shellId
  applySubscribeAction(id, shellRegistry.subscribe(id, ctx.ws, dim(data.cols, 80), dim(data.rows, 24)))
}

const shellUnsubscribe: MessageHandler = (ctx, data) => {
  const shell = shellRegistry.get(str(data.shellId)) // No perm needed to STOP watching.
  if (!shell) return
  applyUnsubAction(shell.entry.shellId, shellRegistry.unsubscribe(shell.entry.shellId, ctx.ws))
}

const shellInput: MessageHandler = (ctx, data) => {
  const shell = requireShell(ctx, data, 'terminal') // WRITE -- typing.
  if (!shell) return
  sendData(shell.entry.shellId, { type: 'shell_input', data: str(data.data) })
}

const shellResize: MessageHandler = (ctx, data) => {
  const shell = requireShell(ctx, data, 'terminal:read') // READ -- own viewport.
  if (!shell) return
  const id = shell.entry.shellId
  applyUnsubAction(id, shellRegistry.resize(id, ctx.ws, dim(data.cols, 80), dim(data.rows, 24)))
}

// ── Data plane: sentinel -> subscribed web ───────────────────────────

const shellData: MessageHandler = (ctx, data) => {
  const shell = shellRegistry.get(str(data.shellId))
  if (!shell || !senderOwnsShell(ctx, shell.machineId)) return
  fanToSubscribers(
    shell.entry.shellId,
    JSON.stringify({ type: 'shell_data', shellId: shell.entry.shellId, data: str(data.data) }),
  )
}

const shellReplay: MessageHandler = (ctx, data) => {
  const shell = shellRegistry.get(str(data.shellId))
  if (!shell || !senderOwnsShell(ctx, shell.machineId)) return
  // Forward to current subscribers (authoritative repaint; at emit time normally
  // just the one viewer that triggered attach).
  fanToSubscribers(
    shell.entry.shellId,
    JSON.stringify({
      type: 'shell_replay',
      shellId: shell.entry.shellId,
      data: str(data.data),
      done: data.done === true,
    }),
  )
}

// ── Control plane: sentinel -> web roster ────────────────────────────

const shellExit: MessageHandler = (ctx, data) => {
  const code = typeof data.code === 'number' ? data.code : 0
  const shell = shellRegistry.remove(str(data.shellId))
  if (!shell) return
  ctx.conversations.broadcastShellScoped(
    { type: 'shell_removed', shellId: shell.entry.shellId, code },
    shell.entry.projectUri,
  )
  if (shell.conversationId) emitShellReceipt(ctx, shell.conversationId, shell.entry, 'exit', code)
  ctx.log.info(`[shell] exit ${shell.entry.shellId} code=${code} uri=${shell.entry.projectUri}`)
}

const shellActivity: MessageHandler = (ctx, data) => {
  const shell = shellRegistry.get(str(data.shellId))
  if (!shell) return
  const ts = typeof data.ts === 'number' ? data.ts : Date.now()
  ctx.conversations.broadcastShellScoped(
    { type: 'shell_activity', shellId: shell.entry.shellId, ts },
    shell.entry.projectUri,
  )
}

// ── Resync (broker restart / control-WS reconnect) ───────────────────

/** Coerce one wire `shell_resync.shells[]` element to a `ShellResyncEntry`,
 *  dropping anything missing the two routing-critical fields. */
function toResyncEntry(v: unknown): ShellResyncEntry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const shellId = str(o.shellId)
  const projectUri = str(o.projectUri)
  if (!shellId || !projectUri) return null
  return {
    shellId,
    projectUri,
    path: str(o.path),
    title: str(o.title),
    createdBy: str(o.createdBy),
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
  }
}

/**
 * `shell_resync` (sentinel -> broker, control WS): the sentinel re-announces its
 * full live shell roster on every (re)connect. The broker reconciles its
 * in-memory roster to this authoritative snapshot -- the ONLY path that re-adds
 * shells lost on a broker restart, and that prunes shells that died while the
 * control WS was down.
 */
const shellResync: MessageHandler = (ctx, data) => {
  const machineId = str(data.machineId)
  if (!machineId) return
  const sentinelId = ctx.conversations.getSentinelIdBySocket(ctx.ws) ?? ''
  const reported = (Array.isArray(data.shells) ? data.shells : [])
    .map(toResyncEntry)
    .filter((e): e is ShellResyncEntry => e !== null)
  const { added, removed, kept } = shellRegistry.reconcile(machineId, sentinelId, reported)
  for (const entry of added)
    ctx.conversations.broadcastShellScoped({ type: 'shell_added', shell: entry }, entry.projectUri)
  for (const shell of removed)
    ctx.conversations.broadcastShellScoped(
      { type: 'shell_removed', shellId: shell.entry.shellId },
      shell.entry.projectUri,
    )
  ctx.log.info(
    `[shell] resync machine=${machineId} sentinel=${sentinelId} reported=${reported.length} added=${added.length} removed=${removed.length} kept=${kept}`,
  )
}

/**
 * `shell_originated` (sentinel -> broker, control WS): a single host shell the
 * sentinel spawned on its own (a host-side `sentinel shell` invocation). The
 * broker builds the roster entry -- `sentinelId` + `machineId` taken from the
 * SENDING connection (never trusted from the payload), `status: 'live'` -- and
 * broadcasts `shell_added`. No write pre-check: the shell is born on the host;
 * roster visibility is gated per-URI on the read side at broadcast/snapshot time.
 * A duplicate shellId is ignored (idempotent with the resync that also carries it).
 *
 * Branch count IS the validation surface here (missing fields / bad URI / dup id
 * / field coercion), same rationale as validateOpen -- hence the ignore below.
 */
// fallow-ignore-next-line complexity
const shellOriginated: MessageHandler = (ctx, data) => {
  const shellId = str(data.shellId)
  const projectUri = str(data.projectUri)
  if (!shellId || !projectUri) return
  const parsed = tryParseProjectUri(projectUri)
  if (!parsed) return
  if (shellRegistry.has(shellId)) return // already known (e.g. raced a resync)
  const sentinelId = ctx.conversations.getSentinelIdBySocket(ctx.ws) ?? ''
  const machineId = ctx.conversations.getSentinelConnection(sentinelId)?.machineId
  const entry: ShellRosterEntry = {
    shellId,
    projectUri,
    sentinelId,
    path: parsed.path,
    title: str(data.title) || basename(parsed.path) || parsed.path,
    status: 'live',
    createdBy: str(data.createdBy) || 'host',
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
  }
  shellRegistry.add(entry, { machineId })
  ctx.conversations.broadcastShellScoped({ type: 'shell_added', shell: entry }, projectUri)
  ctx.log.info(
    `[shell] originated ${shellId} uri=${projectUri} sentinel=${sentinelId} machine=${machineId ?? 'unknown'} by=${entry.createdBy}`,
  )
}

/**
 * Remove every shell owned by a disconnected sentinel + broadcast `shell_removed`
 * for each. Called from the control-WS close handler (no `HandlerContext` there,
 * just the store). The data-WS pairing is forgotten separately on its own close.
 */
export function onSentinelDisconnect(sentinelId: string, conversations: ConversationStore): void {
  // NO TIMEOUTS: the broker is a pure mirror of connection state. A gone control
  // WS means the sentinel is gone (or restarting), so its shells go NOW. The PTYs
  // die with the sentinel; if the control WS merely blipped, `shell_resync` on
  // reconnect re-announces the live shells and rebuilds the roster. The sentinel
  // is the source of truth -- the broker never second-guesses it with a timer.
  const machineId = shellRegistry.machineIdForSentinel(sentinelId)
  if (!machineId) return
  const removed = shellRegistry.removeByMachine(machineId)
  for (const shell of removed) {
    conversations.broadcastShellScoped({ type: 'shell_removed', shellId: shell.entry.shellId }, shell.entry.projectUri)
  }
  if (removed.length > 0)
    console.log(
      `[shell] sentinel ${sentinelId} (machine ${machineId}) gone -- removed ${removed.length} shell(s); will re-announce live shells via shell_resync on reconnect`,
    )
}

/**
 * A web socket disconnected: drop it from every shell it was watching and quiesce
 * the sentinel (detach when it was the last viewer, resize when the min changed).
 */
export function dropShellViewerSocket(ws: ServerWebSocket<unknown>): void {
  for (const { shellId, action } of shellRegistry.dropViewerSocket(ws)) applyUnsubAction(shellId, action)
}

export function registerShellHandlers(): void {
  // Web -> broker (control + data drivers). Control-panel only -- never share.
  registerHandlers(
    {
      shell_open: shellOpen,
      shell_close: shellClose,
      shell_subscribe: shellSubscribe,
      shell_unsubscribe: shellUnsubscribe,
      shell_input: shellInput,
      shell_resize: shellResize,
    },
    WEB_ONLY,
  )
  // Sentinel -> broker (data fan-out + roster lifecycle). Data-WS frames
  // (shell_data/shell_replay) arrive on the dedicated socket, which detectRole
  // tags as the sentinel role via `isShellData`.
  registerHandlers(
    {
      shell_data: shellData,
      shell_replay: shellReplay,
      shell_exit: shellExit,
      shell_activity: shellActivity,
      shell_resync: shellResync,
      shell_originated: shellOriginated,
    },
    SENTINEL_ONLY,
  )
}
