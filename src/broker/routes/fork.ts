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

import { type Context, Hono } from 'hono'
import type { Conversation, ForkPoint } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { runFork } from '../fork-run'
import { buildForkSeedPrompt, generateForkSummary } from '../fork-summary'
import type { RouteHelpers } from './shared'

/**
 * Accept a boundary only if it can actually locate one. A `forkPoint` with
 * neither uuid nor timestamp would silently fold the whole session -- the caller
 * would believe they had cut and get a full copy instead, which is exactly the
 * kind of silent no-op that is worse than a 400.
 */
function normalizeForkPoint(raw: ForkPoint | undefined): ForkPoint | undefined {
  if (!raw) return undefined
  if (raw.direction !== 'before' && raw.direction !== 'after') return undefined
  if (!raw.uuid && !raw.timestamp) return undefined
  return {
    uuid: raw.uuid,
    timestamp: raw.timestamp,
    direction: raw.direction,
    inclusive: raw.inclusive !== false,
    summarizeDropped: raw.summarizeDropped === true,
  }
}

/** What both fork routes need before they can do anything: a parsed body, a real
 *  conversation, and spawn permission on that conversation's project. */
interface ForkRequestBody {
  conversationId?: string
  digestOverTokens?: number
  tailTokenBudget?: number
  /** Opaque passthrough to the sentinel; the broker never resolves either. */
  targetWorktree?: string
  targetCwd?: string
  /** Fold one side of a boundary entry instead of the whole session. */
  forkPoint?: ForkPoint
}

type ForkTarget = { ok: true; body: ForkRequestBody; conversation: Conversation } | { ok: false; response: Response }

/**
 * Both fork routes open the same way -- global spawn permission, a body with a
 * conversationId, the conversation itself, then per-project spawn permission.
 * Keeping that in one place means a permission check can never drift between
 * them, which is the failure mode that matters here.
 */
async function resolveForkTarget(
  c: Context,
  conversationStore: ConversationStore,
  httpHasPermission: RouteHelpers['httpHasPermission'],
): Promise<ForkTarget> {
  const deny = (error: string, status: 400 | 403 | 404) => ({ ok: false as const, response: c.json({ error }, status) })

  if (!httpHasPermission(c.req.raw, 'spawn', '*')) return deny('Forbidden: spawn permission required', 403)

  const body = (await c.req.json().catch(() => null)) as ForkRequestBody | null
  if (!body?.conversationId) return deny('conversationId required', 400)

  const conversation = conversationStore.getConversation(body.conversationId)
  if (!conversation) return deny('Conversation not found', 404)
  if (!httpHasPermission(c.req.raw, 'spawn', conversation.project))
    return deny('Forbidden: spawn permission required for this project', 403)

  return { ok: true, body, conversation }
}

export function createForkRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission } = helpers
  const app = new Hono()

  app.post('/api/fork-cc-session', async c => {
    const target = await resolveForkTarget(c, conversationStore, httpHasPermission)
    if (!target.ok) return target.response
    const { body, conversation } = target

    const forkPoint = normalizeForkPoint(body.forkPoint)
    if (body.forkPoint && !forkPoint)
      return c.json({ error: 'forkPoint needs a direction plus a uuid or timestamp to cut at' }, 400)

    const result = await runFork(conversationStore, conversation, {
      digestOverTokens: body.digestOverTokens,
      tailTokenBudget: body.tailTokenBudget,
      targetWorktree: body.targetWorktree,
      targetCwd: body.targetCwd,
      forkPoint,
    })
    if (!result.ok) return c.json({ error: result.error }, result.status)
    // `cut` says how the boundary actually landed -- by uuid, by timestamp, or not
    // at all. The client needs it to tell the user their slice became a full copy.
    return c.json({ resumeId: result.resumeId, stats: result.stats, cut: result.cut })
  })

  // ─── Fork mode C: written continuation summary ───────────────────────
  // No sentinel round-trip -- the broker already holds the transcript. The fork
  // launches as a FRESH session seeded with this text rather than resuming.
  app.post('/api/fork-summary', async c => {
    const target = await resolveForkTarget(c, conversationStore, httpHasPermission)
    if (!target.ok) return target.response
    const { conversation } = target

    const outcome = await generateForkSummary({
      entries: conversationStore.getTranscriptEntries(conversation.id),
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
