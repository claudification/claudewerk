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

import { Hono } from 'hono'
import type { ConversationStore } from '../conversation-store'
import { runFork } from '../fork-run'
import { buildForkSeedPrompt, generateForkSummary } from '../fork-summary'
import type { RouteHelpers } from './shared'

export function createForkRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission } = helpers
  const app = new Hono()

  app.post('/api/fork-cc-session', async c => {
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)

    const body = (await c.req.json().catch(() => null)) as {
      conversationId?: string
      digestOverTokens?: number
      tailTokenBudget?: number
      /** Opaque passthrough to the sentinel; the broker never resolves either. */
      targetWorktree?: string
      targetCwd?: string
    } | null

    if (!body?.conversationId) return c.json({ error: 'conversationId required' }, 400)

    const conversation = conversationStore.getConversation(body.conversationId)
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'spawn', conversation.project))
      return c.json({ error: 'Forbidden: spawn permission required for this project' }, 403)

    const result = await runFork(conversationStore, conversation, {
      digestOverTokens: body.digestOverTokens,
      tailTokenBudget: body.tailTokenBudget,
      targetWorktree: body.targetWorktree,
      targetCwd: body.targetCwd,
    })
    if (!result.ok) return c.json({ error: result.error }, result.status)
    return c.json({ resumeId: result.resumeId, stats: result.stats })
  })

  // ─── Fork mode C: written continuation summary ───────────────────────
  // No sentinel round-trip -- the broker already holds the transcript. The fork
  // launches as a FRESH session seeded with this text rather than resuming.
  app.post('/api/fork-summary', async c => {
    if (!httpHasPermission(c.req.raw, 'spawn', '*'))
      return c.json({ error: 'Forbidden: spawn permission required' }, 403)

    const body = (await c.req.json().catch(() => null)) as { conversationId?: string } | null
    if (!body?.conversationId) return c.json({ error: 'conversationId required' }, 400)

    const conversation = conversationStore.getConversation(body.conversationId)
    if (!conversation) return c.json({ error: 'Conversation not found' }, 404)
    if (!httpHasPermission(c.req.raw, 'spawn', conversation.project))
      return c.json({ error: 'Forbidden: spawn permission required for this project' }, 403)

    const entries = conversationStore.getTranscriptEntries(body.conversationId)
    const outcome = await generateForkSummary({
      entries,
      conversationTitle: conversation.title || conversation.agentName || undefined,
    })
    if (!outcome.ok) return c.json({ error: outcome.error }, 400)

    return c.json({
      summary: outcome.summary,
      seedPrompt: buildForkSeedPrompt(outcome.summary, {
        conversationId: conversation.id,
        title: conversation.title || conversation.agentName || undefined,
      }),
    })
  })

  return app
}
