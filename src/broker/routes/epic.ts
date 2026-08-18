/**
 * `POST /api/epic` -- the HTTP face of the epic substrate, for the MCP tool and
 * the control panel's RUN button.
 *
 * TWO FAMILIES of action cross this route, and keeping them distinct is the
 * design:
 *   - SENTINEL OPS (`start`/`get`/`pause`/`abort`) forward to the sentinel via
 *     `sendEpicOp`, because the run artifact is a file and the broker owns no
 *     filesystem.
 *   - BROKER ACTIONS (`inspect`/`list`/`beat`/`break_lease`) are answered here,
 *     from the conversation registry, the armed set and the beat ring, plus
 *     reads the broker already makes. They add NO sentinel op -- see
 *     `epic-actions.ts`.
 *
 * The route's own job stays exactly three things: parse, permission-gate, and
 * shape the reply.
 */

import { Hono } from 'hono'
import type { EpicBatonQuery, EpicOpKind } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { sendEpicOp } from '../epic-broker-rpc'
import { forgetArmedEpic, noteArmedEpic } from '../epic-registry'
import { buildSweepDeps } from '../epic-sweep-loop'
import type { Permission } from '../permissions'
import { type ActionInput, BROKER_ACTIONS, BROKER_WRITE_ACTIONS } from './epic-actions'
import { readJsonBody } from './json-body'

/** Anything the route accepts in `op`: a sentinel op or a broker action. */
type EpicAction = EpicOpKind | keyof typeof BROKER_ACTIONS

type EpicHttpBodyReady = EpicHttpBody & { project: string; op: EpicAction; epicId: string }

/** `list` is the one action about the PROJECT rather than about one epic, so it
 *  is the one action that does not carry an `epicId`. */
function validate(b: EpicHttpBody): string | null {
  if (!b.project || !b.op) return 'project + op required'
  if (!b.epicId && b.op !== 'list') return 'epicId required for every op except list'
  return null
}

interface EpicHttpBody {
  project?: string
  op?: EpicAction
  epicId?: string
  start?: Record<string, unknown>
  baton?: EpicBatonQuery
  beats?: number
  reason?: string
  force?: boolean
}

/** `get` is the only sentinel read. Everything else touches the run or the card. */
const WRITE_OPS = new Set<string>(['start', 'patch', 'log_append', 'lease', 'release', 'pause', 'abort'])

/** Sentinel ops a human or an agent may drive from outside. `lease`, `patch` and
 *  `log_append` are ENGINE-INTERNAL: exposing them would let a caller forge a
 *  generation or hand-edit the append-only baton, which is the one thing the
 *  baton exists to prevent. `release` is not here either -- `break_lease` is its
 *  audited public face, and it refuses a live holder. */
const PUBLIC_OPS = new Set<string>(['start', 'get', 'pause', 'abort'])

export interface EpicRouteHelpers {
  httpHasPermission: (req: Request, permission: Permission, project: string, conversationId?: string) => boolean
}

function isBrokerAction(op: string): boolean {
  return Object.hasOwn(BROKER_ACTIONS, op)
}

/** Does this action change anything? Decides `files` vs `files:read`. */
function isWrite(op: string): boolean {
  return isBrokerAction(op) ? BROKER_WRITE_ACTIONS.has(op) : WRITE_OPS.has(op)
}

/**
 * The two gates, together: is this action drivable from outside, and may this
 * caller drive it? Returns the refusal or null.
 */
function refuse(
  body: EpicHttpBodyReady,
  req: Request,
  helpers: EpicRouteHelpers,
): { error: string; status: 400 | 403 } | null {
  if (!isBrokerAction(body.op) && !PUBLIC_OPS.has(body.op)) {
    return { error: `op "${body.op}" is engine-internal and cannot be driven over HTTP`, status: 400 }
  }
  const permission: Permission = isWrite(body.op) ? 'files' : 'files:read'
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

function toActionInput(body: EpicHttpBodyReady): ActionInput {
  return {
    project: body.project,
    epicId: body.epicId,
    ...(body.reason ? { reason: body.reason } : {}),
    ...(body.force ? { force: true } : {}),
    ...(body.beats ? { beats: body.beats } : {}),
    ...(body.baton ? { baton: body.baton } : {}),
  }
}

/** One reply shape, whichever of the two families answered. */
type Reply = { body: Record<string, unknown>; status?: 400 | 403 | 409 | 502 }

/** A BROKER action: answered here, from state the broker already holds. */
async function runBrokerAction(store: ConversationStore, body: EpicHttpBodyReady): Promise<Reply> {
  const result = await BROKER_ACTIONS[body.op](buildSweepDeps(store), toActionInput(body))
  if (!result.ok) return { body: { ok: false, error: result.error }, status: result.status }
  return { body: result }
}

/** A SENTINEL op: forwarded, because the run artifact is a file. */
async function runSentinelOp(store: ConversationStore, body: EpicHttpBodyReady): Promise<Reply> {
  const result = await sendEpicOp(store, body.project, {
    op: body.op as EpicOpKind,
    epicId: body.epicId,
    ...(body.start ? { start: body.start } : {}),
    ...(body.baton ? { baton: body.baton } : {}),
    ...(body.reason ? { reason: body.reason } : {}),
  })
  if (!result.ok) return { body: { ok: false, error: result.error ?? 'epic op failed' }, status: 502 }

  trackRun(body)
  return {
    body: { ok: true, run: result.run ?? null, baton: result.baton ?? [], lease: result.currentLease ?? null },
  }
}

export function createEpicRouter(conversationStore: ConversationStore, helpers: EpicRouteHelpers): Hono {
  const app = new Hono()

  app.post('/api/epic', async c => {
    const parsed = await readJsonBody<EpicHttpBody, EpicHttpBodyReady>(c, validate)
    if ('error' in parsed) return c.json({ ok: false, error: parsed.error }, 400)
    const body = parsed.body

    const refusal = refuse(body, c.req.raw, helpers)
    if (refusal) return c.json({ ok: false, error: refusal.error }, refusal.status)

    const run = isBrokerAction(body.op) ? runBrokerAction : runSentinelOp
    const reply = await run(conversationStore, body)
    return reply.status ? c.json(reply.body, reply.status) : c.json(reply.body)
  })

  return app
}
