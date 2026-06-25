/**
 * HTTP routes for the NIGHTSHIFT artifact layer -- the AGENT writer path.
 *
 *   POST /api/nightshift   one op-envelope { project, op, ... } -> NightshiftResult
 *
 * The dashboard reads/writes the morning report over WS (handlers/nightshift.ts);
 * this HTTP route is the path a SPAWNED nightshift worker (or the night manager)
 * uses to self-report -- it carries the broker Bearer secret + reaches the same
 * sentinel writer. Both funnel into the identical `nightshift_op` on the sentinel,
 * so there is exactly one writer of `.nightshift/`.
 *
 * Auth: writes need `files`, reads need `files:read`. A Bearer-secret caller
 * (every agent host) resolves to admin, like /api/search.
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { tryParseProjectUri } from '../../shared/project-uri'
import type { NightshiftOp, NightshiftOpKind, NightshiftResult } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import type { RouteHelpers } from './shared'

const NIGHTSHIFT_RPC_TIMEOUT_MS = 10_000
const WRITE_OPS = new Set<NightshiftOpKind>([
  'config_write',
  'run_start',
  'report',
  'task_patch',
  'run_finalize',
  'enqueue',
  'dequeue',
])

interface NightshiftHttpBody {
  /** Canonical project URI (the broker resolves it to a host root + sentinel). */
  project: string
  op: NightshiftOpKind
  runId?: string
  config?: NightshiftOp['config']
  runStart?: NightshiftOp['runStart']
  report?: NightshiftOp['report']
  taskPatch?: NightshiftOp['taskPatch']
  finalize?: NightshiftOp['finalize']
  enqueue?: NightshiftOp['enqueue']
  dequeueId?: string
}

/** Resolve the owning sentinel for a project URI; default sentinel as fallback. */
function resolveSentinel(conversationStore: ConversationStore, project: string) {
  const parsed = tryParseProjectUri(project)
  const sentinel =
    (parsed?.authority ? conversationStore.getSentinelByAlias(parsed.authority) : undefined) ??
    conversationStore.getSentinel()
  return { projectRoot: parsed?.path ?? project, sentinel }
}

export function createNightshiftRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const app = new Hono()

  app.post('/api/nightshift', async c => {
    let body: NightshiftHttpBody
    try {
      body = await c.req.json<NightshiftHttpBody>()
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    if (!body.project || !body.op) return c.json({ ok: false, error: 'project + op required' }, 400)

    const isWrite = WRITE_OPS.has(body.op)
    if (!helpers.httpHasPermission(c.req.raw, isWrite ? 'files' : 'files:read', body.project)) {
      return c.json({ ok: false, error: `Forbidden: ${isWrite ? 'files' : 'files:read'} permission required` }, 403)
    }

    const { projectRoot, sentinel } = resolveSentinel(conversationStore, body.project)
    if (!sentinel) return c.json({ ok: false, error: 'No sentinel connected for this project' }, 503)

    const result = await new Promise<NightshiftResult | null>(resolve => {
      const requestId = randomUUID()
      const timeout = setTimeout(() => {
        conversationStore.removeProjectListener(requestId)
        resolve(null)
      }, NIGHTSHIFT_RPC_TIMEOUT_MS)
      conversationStore.addProjectListener(requestId, raw => {
        clearTimeout(timeout)
        resolve(raw as NightshiftResult)
      })
      const op: NightshiftOp = {
        type: 'nightshift_op',
        requestId,
        projectRoot,
        op: body.op,
        runId: body.runId,
        config: body.config,
        runStart: body.runStart,
        report: body.report,
        taskPatch: body.taskPatch,
        finalize: body.finalize,
        enqueue: body.enqueue,
        dequeueId: body.dequeueId,
      }
      sentinel.send(JSON.stringify(op))
    })

    if (!result) return c.json({ ok: false, error: 'sentinel timed out (10s)' }, 504)
    return c.json(result, result.ok ? 200 : 400)
  })

  return app
}
