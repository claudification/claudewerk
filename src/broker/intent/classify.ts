/**
 * ONE call that answers every naming question about a conversation.
 *
 * Pure + injectable: the LLM call arrives as a `ChatFn`, so the whole thing is
 * unit-tested without network (same shape as `desk/classify.ts`).
 */

import type { IntentContext } from '../../shared/transcript-intent-context'
import { conversationShape } from '../../shared/transcript-intent-context'
import type { ChatRequest, ChatResponse } from '../recap/shared/openrouter-client'
import {
  type ConversationIntent,
  INTENT_MAX_TOKENS,
  INTENT_MODEL,
  INTENT_TEMPERATURE,
  intentSystemPrompt,
  intentUserPrompt,
} from './prompt'

export type ChatFn = (req: ChatRequest) => Promise<ChatResponse>

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Pull the JSON object out of a reply that may be fenced or prefaced. Models
 *  obey "ONLY JSON" most of the time; a benchmark must survive the rest. */
export function parseIntent(raw: string): ConversationIntent | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const name = str(j.name)
    const title = str(j.title)
    if (!name && !title) return null
    // `recap` is the field the previous away-summary prompt asked for. Accepted
    // as an alias so a model echoing the older key does not silently produce an
    // empty recap -- caught by the characterization suite during the cutover.
    const description = str(j.description) || str(j.recap)
    return { name, title, description, intent: str(j.intent) }
  } catch {
    return null
  }
}

export interface ClassifyOptions {
  model?: string
  /** Retry budget. Background callers pass 0 to fail fast rather than hold a
   *  slow provider open -- a recap nobody is waiting for must not retry. */
  retries?: number
  /** Override the system prompt -- the benchmark uses this to compare strategies. */
  system?: string
  feature?: string
}

export async function classifyConversation(
  ctx: IntentContext,
  chat: ChatFn,
  opts: ClassifyOptions = {},
): Promise<ConversationIntent | null> {
  const res = await chat({
    feature: opts.feature ?? 'classify-intent',
    model: opts.model ?? INTENT_MODEL,
    system: opts.system ?? intentSystemPrompt(conversationShape(ctx)),
    user: intentUserPrompt(ctx),
    maxTokens: INTENT_MAX_TOKENS,
    temperature: INTENT_TEMPERATURE,
    responseFormat: { type: 'json_object' },
    ...(opts.retries !== undefined && { retries: opts.retries }),
  })
  return parseIntent(res.content ?? '')
}
