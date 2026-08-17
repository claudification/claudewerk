/**
 * `POST /api/epic` -- the HTTP face of the epic substrate, for the MCP tool and
 * the control panel's RUN button.
 *
 * Uses `sendEpicOp` (broker-sentinel-rpc) rather than re-implementing the
 * request/timeout dance a fourth time. The route's own job is exactly three
 * things: parse, permission-gate, and shape the reply.
 */

import { Hono } from 'hono'
import type { EpicOpKind } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { sendEpicOp } from '../epic-broker-rpc'
import { forgetArmedEpic, noteArmedEpic } from '../epic-registry'
import type { Permission } from '../permissions'
import { readJsonBody } from './json-body'

/** The body once `readJsonBody`'s validator has confirmed the three required
 *  fields -- so the handler below never re-checks them. */
type EpicHttpBodyReady = EpicHttpBody & { project: string; op: EpicOpKind; epicId: string }

interface EpicHttpBody {
  project?: string
  op?: EpicOpKind
  epicId?: string
  start?: Record<string, unknown>
  reason?: string
}

/** `get` is the only read. Everything else touches the run or the epic card. */
const WRITE_OPS = new Set<EpicOpKind>(['start', 'patch', 'log_append', 'lease', 'release', 'pause', 'abort'])

/** Ops a human or an agent may drive from outside. `lease`, `patch` and
 *  `log_append` are ENGINE-INTERNAL: exposing them would let a caller forge a
 *  generation or hand-edit the append-only baton, which is the one thing the
 *  baton exists to prevent. */
const PUBLIC_OPS = new Set<EpicOpKind>(['start', 'get', 'pause', 'abort'])

export interface EpicRouteHelpers {
  httpHasPermission: (req: Request, permission: Permission, project: string, conversationId?: string) => boolean
}

/** The two gates, together: is this op drivable from outside, and may this
 *  caller drive it? Returns the refusal or null. Lifted out of the handler so
 *  the handler reads as parse -> gate -> forward. */
function refuse(
  body: EpicHttpBodyReady,
  req: Request,
  helpers: EpicRouteHelpers,
): { error: string; status: 400 | 403 } | null {
  if (!PUBLIC_OPS.has(body.op)) {
    return { error: `op "${body.op}" is engine-internal and cannot be driven over HTTP`, status: 400 }
  }
  const permission: Permission = WRITE_OPS.has(body.op) ? 'files' : 'files:read'
  if (!helpers.httpHasPermission(req, permission, body.project)) {
    return { error: `Forbidden: ${permission} permission required`, status: 403 }
  }
  return null
}

/**
 * Keep the sweep's armed-epic set in step with what just happened.
 *
 * Called ONLY after a successful op: registering an epic whose sentinel refused
 * the write would leave the sweep beating on a run that does not exist. Arming
 * is what lets the sweep find an epic before it has any conversations -- see
 * epic-registry.ts for the chicken-and-egg this closes.
 */
function trackRun(body: EpicHttpBodyReady): void {
  if (body.op === 'start') noteArmedEpic(body.project, body.epicId)
  else if (body.op === 'pause' || body.op === 'abort') forgetArmedEpic(body.project, body.epicId)
}

export function createEpicRouter(conversationStore: ConversationStore, helpers: EpicRouteHelpers): Hono {
  const app = new Hono()

  app.post('/api/epic', async c => {
    const parsed = await readJsonBody<EpicHttpBody, EpicHttpBodyReady>(c, b =>
      b.project && b.op && b.epicId ? null : 'project + op + epicId required',
    )
    if ('error' in parsed) return c.json({ ok: false, error: parsed.error }, 400)
    const body = parsed.body
    const refusal = refuse(body, c.req.raw, helpers)
    if (refusal) return c.json({ ok: false, error: refusal.error }, refusal.status)

    const result = await sendEpicOp(conversationStore, body.project, {
      op: body.op,
      epicId: body.epicId,
      ...(body.start ? { start: body.start } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    })
    if (!result.ok) return c.json({ ok: false, error: result.error ?? 'epic op failed' }, 502)

    trackRun(body)
    return c.json({ ok: true, run: result.run ?? null, baton: result.baton ?? [] })
  })

  return app
}
