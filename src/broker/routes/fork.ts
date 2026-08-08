/**
 * Fork route -- POST /api/fork-cc-session
 *
 * Folds an existing CC session into a NEW resumable one and returns the fresh
 * ccSessionId. This is deliberately SEPARATE from spawning: the caller forks
 * first, shows the user what the fold bought (675k -> 114k on a real session),
 * and only then spawns with `mode: 'resume'` + that id.
 *
 * The broker does no filesystem work and reads no transcript -- it relays to
 * the sentinel, which owns URI<->path (CWD-IS-INFORMATIONAL) and is the only
 * component that touches the host FS.
 */

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { ForkCcSessionResult } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import type { RouteHelpers } from './shared'

/** Folding a multi-MB transcript is real work; well clear of the 5s used for listing. */
const FORK_TIMEOUT_MS = 60_000

export function createForkRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission } = helpers
  const app = new Hono()

  app.post('/api/fork-cc-session', async c => {
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)

    const body = (await c.req.json().catch(() => null)) as {
      cwd?: string
      sourceCcSessionId?: string
      sentinel?: string
      profile?: string
      digestOverTokens?: number
      tailTokenBudget?: number
    } | null

    if (!body?.cwd) return c.json({ error: 'cwd required' }, 400)
    if (!body.sourceCcSessionId) return c.json({ error: 'sourceCcSessionId required' }, 400)

    const sentinel = body.sentinel
      ? conversationStore.getSentinelByAlias(body.sentinel)
      : conversationStore.getSentinel()
    if (!sentinel) {
      const which = body.sentinel ? `Sentinel "${body.sentinel}" not connected` : 'No sentinel connected'
      return c.json({ error: which }, 503)
    }

    const requestId = randomUUID()
    let result: ForkCcSessionResult
    try {
      result = await new Promise<ForkCcSessionResult>((resolve, reject) => {
        const timeout = setTimeout(() => {
          conversationStore.removeForkListener(requestId)
          reject(new Error(`Fork timed out (${FORK_TIMEOUT_MS / 1000}s)`))
        }, FORK_TIMEOUT_MS)

        conversationStore.addForkListener(requestId, msg => {
          clearTimeout(timeout)
          resolve(msg as ForkCcSessionResult)
        })

        sentinel.send(
          JSON.stringify({
            type: 'fork_cc_session',
            requestId,
            cwd: body.cwd,
            sourceCcSessionId: body.sourceCcSessionId,
            profile: body.profile,
            digestOverTokens: body.digestOverTokens,
            tailTokenBudget: body.tailTokenBudget,
          }),
        )
      })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 504)
    }

    if (result.error) return c.json({ error: result.error }, 400)
    return c.json({ resumeId: result.resumeId, stats: result.stats })
  })

  return app
}
