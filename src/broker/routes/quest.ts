/**
 * HTTP route for the QUEST substrate -- the AGENT path.
 *
 *   POST /api/quest   one op-envelope { project, op, ... } -> QuestResult
 *
 * The dashboard reads/writes quests over WS (handlers/quest.ts); this HTTP route
 * is the path a quest LEG (or intake conversation) uses to author + steer its
 * quest -- it carries the broker Bearer secret + reaches the same sentinel
 * writer. Both funnel into the identical `quest_op` on the sentinel, so there is
 * exactly one writer of the quest tree.
 *
 * Auth: writes need `files`, reads need `files:read`. A Bearer-secret caller
 * (every agent host) resolves to admin, like /api/nightshift. Boundary: never
 * touches ccSessionId; projectRoot comes from the trusted project URI.
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { tryParseProjectUri } from '../../shared/project-uri'
import type { QuestOp, QuestOpKind, QuestResult } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import type { RouteHelpers } from './shared'

const QUEST_RPC_TIMEOUT_MS = 10_000
const WRITE_OPS = new Set<QuestOpKind>(['create', 'update', 'log_append', 'abort', 'pause'])

interface QuestHttpBody {
  /** Canonical project URI (the broker resolves it to a host root + sentinel). */
  project: string
  op: QuestOpKind
  petname?: string
  create?: QuestOp['create']
  patch?: QuestOp['patch']
  logAppend?: QuestOp['logAppend']
  reason?: string
}

// The whole router mirrors the nightshift artifact route by design (same
// broker->sentinel relay idiom); the shared-relay extraction is deliberately
// out of scope for this packet (would touch shipped nightshift/project code).
// fallow-ignore-next-line code-duplication
/** Resolve the owning sentinel for a project URI; default sentinel as fallback. */
function resolveSentinel(conversationStore: ConversationStore, project: string) {
  const parsed = tryParseProjectUri(project)
  const sentinel =
    (parsed?.authority ? conversationStore.getSentinelByAlias(parsed.authority) : undefined) ??
    conversationStore.getSentinel()
  return { projectRoot: parsed?.path ?? project, sentinel }
}

export function createQuestRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const app = new Hono()

  // fallow-ignore-next-line complexity
  app.post('/api/quest', async c => {
    // fallow-ignore-next-line code-duplication
    let body: QuestHttpBody
    try {
      body = await c.req.json<QuestHttpBody>()
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 400)
    }
    if (!body.project || !body.op) return c.json({ ok: false, error: 'project + op required' }, 400)

    const isWrite = WRITE_OPS.has(body.op)
    if (!helpers.httpHasPermission(c.req.raw, isWrite ? 'files' : 'files:read', body.project)) {
      return c.json({ ok: false, error: `Forbidden: ${isWrite ? 'files' : 'files:read'} permission required` }, 403)
    }

    // fallow-ignore-next-line code-duplication
    const { projectRoot, sentinel } = resolveSentinel(conversationStore, body.project)
    if (!sentinel) return c.json({ ok: false, error: 'No sentinel connected for this project' }, 503)

    const result = await new Promise<QuestResult | null>(resolve => {
      const requestId = randomUUID()
      const timeout = setTimeout(() => {
        conversationStore.removeProjectListener(requestId)
        resolve(null)
      }, QUEST_RPC_TIMEOUT_MS)
      conversationStore.addProjectListener(requestId, raw => {
        clearTimeout(timeout)
        resolve(raw as QuestResult)
      })
      const op: QuestOp = {
        type: 'quest_op',
        requestId,
        projectRoot,
        op: body.op,
        petname: body.petname,
        create: body.create,
        patch: body.patch,
        logAppend: body.logAppend,
        reason: body.reason,
      }
      sentinel.send(JSON.stringify(op))
    })

    if (!result) return c.json({ ok: false, error: 'sentinel timed out (10s)' }, 504)
    return c.json(result, result.ok ? 200 : 400)
  })

  return app
}
