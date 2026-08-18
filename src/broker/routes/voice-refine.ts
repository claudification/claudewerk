/**
 * Voice refine route -- the DIRECT path's way into the refiner.
 *
 * WHY THIS EXISTS (2026-08-18): `refineTranscript()` had exactly one caller,
 * voice-stream.ts, which is the RELAY path. The default path is direct
 * (browser -> stt-proxy Worker -> Deepgram) and never routes a transcript
 * through the broker at all, so the refiner was dead code for anyone on the
 * default and the settings UI hid itself rather than lie about it
 * (items-voice-engine.tsx). This route is the missing seam: the browser hands
 * over the finished transcript, the broker does the LLM work, the browser gets
 * text back.
 *
 * REFINEMENT IS BROKER-SIDE ON PURPOSE. It could have been a fetch from the
 * browser to OpenRouter, and that would have been worse in three ways: the API
 * key would have to reach the client, the spend would escape
 * `recordOpenRouterSpend`'s per-feature accounting, and -- the reason it was
 * called out -- the 2s deadline would then be measuring the user's network
 * rather than the model. The broker's clock sees model latency only.
 *
 * It CANNOT fail the caller. Every error path returns 200 with the raw text, so
 * a refiner outage degrades dictation to unrefined rather than to nothing.
 */

import { Hono } from 'hono'
import type { ConversationStore } from '../conversation-store'
import { resolveKeyterms } from '../voice-keyterms'
import { refinementSkipReason, refineTranscript } from '../voice-refiner'
import type { RouteHelpers } from './shared'

/** Matches the relay path's own ceiling on a single dictation. Longer than any
 *  real utterance; a body past this is a bug or an attack, not speech. */
const MAX_TRANSCRIPT_CHARS = 20000

interface RefineBody {
  text?: string
  conversationId?: string
  project?: string
}

/**
 * Everything that can stop a refine before it costs anything. Separated from the
 * handler so the decision is one readable list rather than a stack of early
 * returns tangled with the work -- and so it is unit-testable without a server.
 *
 * `'forbidden'` is the only hard failure; every other outcome is a 200 carrying
 * the raw text, because a refusal to refine is not a refusal to dictate.
 */
export function screenRefineRequest(
  deps: { isShareGuest: boolean; hasVoicePermission: boolean; project: string | null },
  text: string,
): 'forbidden' | 'share guest' | string | null {
  // A share guest holds a token scoped to ONE conversation and has no business
  // spending the operator's OpenRouter budget on their own dictation.
  if (deps.isShareGuest) return 'share guest'
  if (deps.project && !deps.hasVoicePermission) return 'forbidden'
  return refinementSkipReason(text)
}

export function createVoiceRefineRouter(conversationStore: ConversationStore, helpers: RouteHelpers): Hono {
  const { httpHasPermission, shareScopedConversationId } = helpers
  const app = new Hono()

  app.post('/api/voice/refine', async c => {
    const { text, conversationId, project } = resolveRequest(await readBody(c), conversationStore)
    const verdict = screenRefineRequest(
      {
        isShareGuest: Boolean(shareScopedConversationId(c.req.raw)),
        // Same permission the relay path's dictation needs -- refinement is part
        // of the voice pipeline, not a separate capability.
        hasVoicePermission: hasVoice(httpHasPermission, c.req.raw, project, conversationId),
        project,
      },
      text,
    )
    if (verdict === 'forbidden') return c.json({ error: 'Forbidden' }, 403)
    if (verdict) return c.json({ raw: text, refined: text, skipped: verdict })

    const keyterms = resolveKeyterms(conversationStore, project, conversationId)
    const refined = await refineTranscript(text, keyterms)
    return c.json({ raw: text, refined, keyterms: keyterms.length })
  })

  return app
}

interface RefineRequest {
  text: string
  conversationId: string | null
  project: string | null
}

/** Body -> the three things the handler acts on. Extracted so the route handler
 *  itself stays a straight line: parse, screen, refine. */
export function resolveRequest(body: RefineBody, store: ConversationStore): RefineRequest {
  const conversationId = body.conversationId ?? null
  const fromConversation = conversationId ? store.getConversation(conversationId)?.project : null
  return {
    text: (body.text ?? '').slice(0, MAX_TRANSCRIPT_CHARS),
    conversationId,
    project: body.project || fromConversation || null,
  }
}

/** No project means nothing to scope a permission against -- an ad-hoc dictation
 *  must not 403 on a check that has no subject. */
function hasVoice(
  check: RouteHelpers['httpHasPermission'],
  req: Request,
  project: string | null,
  conversationId: string | null,
): boolean {
  if (!project) return true
  return check(req, 'voice', project, conversationId ?? undefined)
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<RefineBody> {
  try {
    return ((await c.req.json()) ?? {}) as RefineBody
  } catch {
    return {}
  }
}
