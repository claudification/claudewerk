/**
 * `POST /api/epic` -- the HTTP face of the epic substrate, for the MCP tool and
 * the control panel's RUN button.
 *
 * TWO FAMILIES of action cross this route, and keeping them distinct is the
 * design:
 *   - SENTINEL OPS (`start`/`get`/`pause`/`abort`) forward to the sentinel via
 *     `sendEpicOp`, because the run artifact is a file and the broker owns no
 *     filesystem.
 *   - BROKER ACTIONS (`inspect`/`list`/`beat`/`break_lease`/`delete`) are
 *     answered here, from the conversation registry, the armed set and the beat
 *     ring, plus reads the broker already makes. `break_lease` and `delete` do
 *     forward to the sentinel in the end; they live on this side because each
 *     carries a refusal only the BROKER can make (is the lease holder alive, is
 *     a seat still writing to this run) -- see `epic-actions.ts`.
 *
 * The route's own job stays exactly three things: parse, permission-gate, and
 * shape the reply.
 */

import { Hono } from 'hono'
import type { EpicBatonQuery, EpicOpKind } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { listActiveEpicRuns } from '../epic-active'
import { normalizeWhen, sendEpicOp } from '../epic-broker-rpc'
import { forgetArmedEpic, forgetDeletedEpic, noteArmedEpic } from '../epic-registry'
import { buildSweepDeps } from '../epic-sweep-loop'
import type { Permission } from '../permissions'
import { scannerEnabledForProject } from '../project-settings'
import { type ActionInput, BROKER_ACTIONS, BROKER_WRITE_ACTIONS } from './epic-actions'
import { readJsonBody } from './json-body'

/** Anything the route accepts in `op`: a sentinel op or a broker action. */
type EpicAction = EpicOpKind | keyof typeof BROKER_ACTIONS | 'active'

type EpicHttpBodyReady = EpicHttpBody & { project: string; op: EpicAction; epicId: string }

/**
 * The two actions that are not about one epic, and the one that is not even
 * about one project:
 *   - `list` is about a PROJECT, so it carries no `epicId`.
 *   - `active` is about the BOX, so it carries neither. It is what the header
 *     badge asks, and a badge cannot know which project to name before it has
 *     been told what is running.
 */
function validate(b: EpicHttpBody): string | null {
  if (!b.op) return 'op required'
  if (b.op === 'active') return null
  if (!b.project) return 'project + op required'
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
const WRITE_OPS = new Set<string>(['start', 'patch', 'log_append', 'lease', 'release', 'pause', 'abort', 'clear'])

/** Sentinel ops a human or an agent may drive from outside. `lease`, `patch` and
 *  `log_append` are ENGINE-INTERNAL: exposing them would let a caller forge a
 *  generation or hand-edit the append-only baton, which is the one thing the
 *  baton exists to prevent. `release` is not here either -- `break_lease` is its
 *  audited public face, and it refuses a live holder. */
const PUBLIC_OPS = new Set<string>(['start', 'get', 'pause', 'abort', 'clear'])

/** Ops that change whether a run is live, and so must reach the badge NOW
 *  rather than on the next sweep tick. `get` is a read and changes nothing. */
const PUBLISHING_OPS = new Set<string>(['start', 'pause', 'abort', 'clear'])

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
 * The three gates, together: is this action drivable from outside, may this
 * caller drive it, and -- for `start` alone -- has this project opted in to being
 * swept at all? Returns the refusal or null.
 *
 * THE OPT-IN CHECK IS HERE BECAUSE ARMING IS THE OTHER CALLER. The sweep drops an
 * armed run in an opted-out project (epic-sweep-loop.ts), so without this a
 * `start` would report success and then sit `armed` forever with nothing coming
 * to beat it -- the silent hang, told at the one moment a human could have fixed
 * it in two clicks.
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
  if (body.op === 'start' && !scannerEnabledForProject(body.project, 'epics')) {
    return {
      error:
        `the "epics" scanner is off for ${body.project}, so an armed run would never be swept -- ` +
        `tick it in Project Settings > Scanners first`,
      status: 400,
    }
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
  if (body.op === 'start') {
    noteArmedEpic(body.project, body.epicId)
    // ARMING UN-DELETES. A `start` writes a fresh `run.md`, so the epic has a
    // real run again -- leaving its tombstone in place would keep that new run
    // off the wall, the badge and `list` while it was genuinely running, which
    // is the invisibility the whole tail section exists to prevent.
    forgetDeletedEpic(body.project, body.epicId)
  } else if (body.op === 'pause' || body.op === 'abort') forgetArmedEpic(body.project, body.epicId)
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

/**
 * `active` -- the cross-project feed, gated PER ROW.
 *
 * Every other action takes one project and asks one permission question about
 * it. This one spans the box, so the gate moves inside: compute the whole feed,
 * then hand back only the rows whose project this caller may read. A share
 * viewer bound to one project therefore sees a badge that counts only their own
 * runs, which is the same answer the rest of the panel already gives them.
 */
async function runActive(store: ConversationStore, req: Request, helpers: EpicRouteHelpers): Promise<Reply> {
  const rows = await listActiveEpicRuns(buildSweepDeps(store))
  return { body: { ok: true, active: rows.filter(r => helpers.httpHasPermission(req, 'files:read', r.project)) } }
}

/** The wire payload for a sentinel op: the three optional halves, added only
 *  when present so the sentinel never sees an explicit `undefined`. */
function toSentinelOp(body: EpicHttpBodyReady): Parameters<typeof sendEpicOp>[2] {
  return {
    op: body.op as EpicOpKind,
    epicId: body.epicId,
    ...(body.start ? { start: body.start } : {}),
    ...(body.baton ? { baton: body.baton } : {}),
    ...(body.reason ? { reason: body.reason } : {}),
  }
}

/** A SENTINEL op: forwarded, because the run artifact is a file. */
async function runSentinelOp(store: ConversationStore, body: EpicHttpBodyReady): Promise<Reply> {
  const result = await sendEpicOp(store, body.project, toSentinelOp(body))
  if (!result.ok) return { body: { ok: false, error: result.error ?? 'epic op failed' }, status: 502 }

  trackRun(body)
  // Arming, pausing and aborting are the three moments a human is definitely
  // looking at the badge, so they do not wait for the next 45s tick to be
  // reflected. `void` deliberately: the reply must not block on a broadcast.
  if (PUBLISHING_OPS.has(body.op)) void buildSweepDeps(store).publishActivity?.()
  return {
    body: {
      ok: true,
      // The SAME normalisation `toEpicRunView` applies, for the same version-skew
      // reason: an older sentinel answers with `cadence` as a bare string, and
      // this is the reply the control panel reads directly rather than through
      // the beat's view. See `normalizeWhen`.
      run: normalizeWhen(result.run ?? null),
      baton: result.baton ?? [],
      lease: result.currentLease ?? null,
    },
  }
}

export function createEpicRouter(conversationStore: ConversationStore, helpers: EpicRouteHelpers): Hono {
  const app = new Hono()

  app.post('/api/epic', async c => {
    const parsed = await readJsonBody<EpicHttpBody, EpicHttpBodyReady>(c, validate)
    if ('error' in parsed) return c.json({ ok: false, error: parsed.error }, 400)
    const body = parsed.body

    // `active` gates per row rather than up front -- it has no single project
    // to ask about, so it must be answered before `refuse` can be meaningful.
    if (body.op === 'active') {
      const reply = await runActive(conversationStore, c.req.raw, helpers)
      return c.json(reply.body)
    }

    const refusal = refuse(body, c.req.raw, helpers)
    if (refusal) return c.json({ ok: false, error: refusal.error }, refusal.status)

    const run = isBrokerAction(body.op) ? runBrokerAction : runSentinelOp
    const reply = await run(conversationStore, body)
    return reply.status ? c.json(reply.body, reply.status) : c.json(reply.body)
  })

  return app
}
