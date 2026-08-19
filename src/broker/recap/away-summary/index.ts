import { conversationShape } from '../../../shared/transcript-intent-context'
import type { ConversationStore } from '../../conversation-store'
import { classifyConversation } from '../../intent/classify'
import { intentContextFromEntries } from '../../intent/from-entries'
import { chat } from '../shared/openrouter-client'
import { persistResult } from './persist'
import { AWAY_SUMMARY_DELAY_MS, AWAY_SUMMARY_MODEL } from './prompt'

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()

type ReplyFn = (msg: Record<string, unknown>) => void

export function scheduleRecap(store: ConversationStore, conversationId: string): void {
  if (!process.env.OPENROUTER_API_KEY) return
  cancelRecap(conversationId)
  const timer = setTimeout(() => {
    pendingTimers.delete(conversationId)
    const conv = store.getConversation(conversationId)
    if (conv?.status !== 'idle') return
    runGeneration(store, conversationId, { allowEnded: false }).catch(err => {
      logFailure('generation failed', conversationId, err)
    })
  }, AWAY_SUMMARY_DELAY_MS)
  pendingTimers.set(conversationId, timer)
}

export function cancelRecap(conversationId: string): void {
  const timer = pendingTimers.get(conversationId)
  if (!timer) return
  clearTimeout(timer)
  pendingTimers.delete(conversationId)
}

export function generateRecapOnEnd(store: ConversationStore, conversationId: string): void {
  if (!process.env.OPENROUTER_API_KEY) return
  const conv = store.getConversation(conversationId)
  if (!conv || conv.recap) return
  cancelRecap(conversationId)
  runGeneration(store, conversationId, { allowEnded: true }).catch(err => {
    logFailure('end-of-conversation generation failed', conversationId, err)
  })
}

export function generateRecapManual(store: ConversationStore, conversationId: string, reply?: ReplyFn): void {
  const replyResult = makeReplyResult(conversationId, reply)
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('[recap] manual generation skipped -- no OPENROUTER_API_KEY')
    replyResult(false, 'No OPENROUTER_API_KEY configured on broker')
    return
  }
  if (!store.getConversation(conversationId)) {
    replyResult(false, 'Conversation not found')
    return
  }
  cancelRecap(conversationId)
  console.log(`[recap] manual generation requested for ${conversationId.slice(0, 8)}`)
  runGeneration(store, conversationId, { allowEnded: true, reply }).catch(err => {
    logFailure('manual generation failed', conversationId, err)
    replyResult(false, `Recap generation failed: ${err}`)
  })
}

interface GenerationOptions {
  allowEnded: boolean
  reply?: ReplyFn
}

// fallow-ignore-next-line complexity
async function runGeneration(store: ConversationStore, conversationId: string, opts: GenerationOptions): Promise<void> {
  const replyResult = makeReplyResult(conversationId, opts.reply)
  const conv = store.getConversation(conversationId)
  if (!conv || (!opts.allowEnded && conv.status !== 'idle')) {
    replyResult(false, 'Conversation not available for recap')
    return
  }

  let entries = store.getTranscriptEntries(conversationId)
  if (entries.length === 0) entries = store.loadTranscriptFromStore(conversationId, 200) || []
  const ctx = intentContextFromEntries(entries)
  // Same floor the condensed path enforced: a conversation with nothing in it
  // yields a confident-sounding recap about nothing.
  const contentChars = ctx.userMessages.reduce((n, m) => n + m.text.length, 0) + ctx.activity.join('').length
  if (ctx.userMessages.length === 0 || contentChars < 50) {
    console.log(`[recap] insufficient content for ${conversationId.slice(0, 8)} (${contentChars} chars), skipping`)
    replyResult(false, 'Not enough conversation content to generate a recap')
    return
  }

  console.log(
    `[recap] generating for ${conversationId.slice(0, 8)} ` +
      `(${ctx.userMessages.length} user msgs, ${ctx.activity.length} activity, shape=${conversationShape(ctx)})`,
  )

  let intent: Awaited<ReturnType<typeof classifyConversation>> = null
  try {
    intent = await classifyConversation(ctx, chat, { model: AWAY_SUMMARY_MODEL, feature: 'recap-away-summary', retries: 0 })
  } catch (err) {
    const status = isHttpStatusError(err) ? err.status : undefined
    if (status != null) {
      console.log(`[recap] OpenRouter returned ${status} for ${conversationId.slice(0, 8)}`)
      replyResult(false, `OpenRouter API returned ${status}`)
    } else {
      logFailure('OpenRouter call failed', conversationId, err)
      replyResult(false, `OpenRouter call failed: ${describe(err)}`)
    }
    return
  }

  if (!intent) {
    console.log(`[recap] unusable response for ${conversationId.slice(0, 8)}`)
    replyResult(false, 'Model returned invalid response (no JSON)')
    return
  }

  // persistResult still speaks the away_summary shape that the transcript entry
  // and every existing reader expect. The primitive's `description` IS the
  // recap -- one call now answers what three prompts used to disagree about.
  const rawText = JSON.stringify({ title: intent.title, recap: intent.description, name: intent.name })
  persistResult(store, conversationId, rawText, opts.allowEnded)
  replyResult(true)
}

function makeReplyResult(conversationId: string, reply?: ReplyFn) {
  return (ok: boolean, error?: string) => {
    if (!reply) return
    reply({ type: 'recap_request_result', conversationId, ok, ...(error ? { error } : {}) })
  }
}

function isHttpStatusError(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' && err !== null && 'status' in err && typeof (err as { status: number }).status === 'number'
  )
}

function logFailure(label: string, conversationId: string, err: unknown): void {
  console.log(`[recap] ${label} for ${conversationId.slice(0, 8)}: ${describe(err)}`)
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
