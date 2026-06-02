/**
 * Project store relay: dashboard <-> sentinel.
 *
 * The board + markdown viewer read/write project files THROUGH THE SENTINEL
 * (not a live agent host), so they work with zero running conversations. The
 * dashboard sends a project URI; the broker resolves it to an absolute
 * `projectRoot` + the owning sentinel, forwards the sentinel-side RPC, and
 * relays the result back to the requesting socket. Live board updates arrive
 * as `project_changed` (sentinel -> broker) and are broadcast permission-gated
 * by the project URI.
 *
 * Boundary: this handler never touches ccSessionId. projectRoot comes from the
 * trusted project URI; the sentinel jails every relative path under it.
 */

import { parseProjectUri } from '../../shared/project-uri'
import type {
  ProjectBoardOp,
  ProjectBoardRequest,
  ProjectFileRequest,
  ProjectReadFile,
  ProjectSubscribe,
  ProjectUnsubscribe,
} from '../../shared/protocol'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers, SENTINEL_ONLY } from '../message-router'
import { subscribeProjectWatch, unsubscribeProjectWatch } from '../project-watch-registry'

const BOARD_WRITE_OPS = new Set<ProjectBoardOp['op']>(['create', 'update', 'move', 'delete'])
const PROJECT_RPC_TIMEOUT_MS = 10_000

/** Resolve a project URI to its host root + owning sentinel socket. */
function resolveTarget(ctx: HandlerContext, project: string) {
  const parsed = parseProjectUri(project)
  const sentinel =
    (parsed.authority ? ctx.conversations.getSentinelByAlias(parsed.authority) : undefined) ?? ctx.getSentinel()
  return { projectRoot: parsed.path, sentinel }
}

/**
 * Forward one project RPC to the sentinel and wire the reply back to the caller.
 * `build(projectRoot)` produces the sentinel-bound message; `replyType` is used
 * for the synthetic error envelope when there's no sentinel / it times out.
 */
function forward(
  ctx: HandlerContext,
  requestId: string,
  project: string,
  isWrite: boolean,
  replyType: string,
  build: (projectRoot: string) => Record<string, unknown>,
): void {
  // Throws GuardError (router replies the error) if the caller lacks access.
  ctx.requirePermission(isWrite ? 'files' : 'files:read', project)

  const { projectRoot, sentinel } = resolveTarget(ctx, project)
  const replyWs = ctx.ws
  const sendReply = (msg: Record<string, unknown>) => {
    try {
      replyWs.send(JSON.stringify(msg))
    } catch {
      /* socket gone -- caller navigated away */
    }
  }

  if (!sentinel) {
    sendReply({ type: replyType, requestId, ok: false, error: 'no sentinel connected for project' })
    return
  }

  const timeout = setTimeout(() => {
    ctx.conversations.removeProjectListener(requestId)
    sendReply({ type: replyType, requestId, ok: false, error: 'sentinel timed out (10s)' })
  }, PROJECT_RPC_TIMEOUT_MS)

  ctx.conversations.addProjectListener(requestId, result => {
    clearTimeout(timeout)
    sendReply(result as Record<string, unknown>)
  })

  try {
    sentinel.send(JSON.stringify(build(projectRoot)))
  } catch {
    clearTimeout(timeout)
    ctx.conversations.removeProjectListener(requestId)
    sendReply({ type: replyType, requestId, ok: false, error: 'sentinel send failed' })
  }
}

// Dashboard -> broker: board CRUD.
const projectBoardRequest: MessageHandler = (ctx, data) => {
  const d = data as ProjectBoardRequest
  if (!d.project || !d.requestId || !d.op) return
  forward(ctx, d.requestId, d.project, BOARD_WRITE_OPS.has(d.op), 'project_board_result', projectRoot => {
    const op: ProjectBoardOp = {
      type: 'project_board_op',
      requestId: d.requestId,
      projectRoot,
      op: d.op,
      status: d.status,
      slug: d.slug,
      filterStatus: d.filterStatus,
      refs: d.refs,
      input: d.input,
      patch: d.patch,
      fromStatus: d.fromStatus,
      toStatus: d.toStatus,
    }
    return op as unknown as Record<string, unknown>
  })
}

// Dashboard -> broker: read a project-relative file (markdown viewer).
const projectFileRequest: MessageHandler = (ctx, data) => {
  const d = data as ProjectFileRequest
  if (!d.project || !d.requestId || !d.relPath) return
  forward(ctx, d.requestId, d.project, false, 'project_read_file_result', projectRoot => {
    const req: ProjectReadFile = {
      type: 'project_read_file',
      requestId: d.requestId,
      projectRoot,
      relPath: d.relPath,
      maxBytes: d.maxBytes,
    }
    return req as unknown as Record<string, unknown>
  })
}

// Dashboard -> broker: started viewing a project board -> arm the lease watch.
const projectSubscribe: MessageHandler = (ctx, data) => {
  const d = data as ProjectSubscribe
  if (!d.project) return
  ctx.requirePermission('files:read', d.project)
  subscribeProjectWatch(ctx.ws, d.project)
}

// Dashboard -> broker: stopped viewing a project board -> disarm if last viewer.
const projectUnsubscribe: MessageHandler = (ctx, data) => {
  const d = data as ProjectUnsubscribe
  if (!d.project) return
  unsubscribeProjectWatch(ctx.ws, d.project)
}

// Sentinel -> broker: RPC result -> resolve the pending listener (replies to caller).
const projectResult: MessageHandler = (ctx, data: MessageData) => {
  if (data.requestId) ctx.conversations.resolveProject(data.requestId as string, data)
}

// Sentinel -> broker: live board change -> broadcast permission-gated by project.
const projectChanged: MessageHandler = (ctx, data: MessageData) => {
  const project = data.project as string | undefined
  if (project) ctx.broadcastScoped(data, project)
  else ctx.log.debug('[project] dropping project_changed: no project URI')
}

export function registerProjectHandlers(): void {
  registerHandlers(
    {
      project_board_request: projectBoardRequest,
      project_file_request: projectFileRequest,
      project_subscribe: projectSubscribe,
      project_unsubscribe: projectUnsubscribe,
    },
    DASHBOARD_ROLES,
  )
  registerHandlers(
    {
      project_board_result: projectResult,
      project_read_file_result: projectResult,
      project_write_file_result: projectResult,
      project_move_file_result: projectResult,
      project_changed: projectChanged,
    },
    SENTINEL_ONLY,
  )
}
