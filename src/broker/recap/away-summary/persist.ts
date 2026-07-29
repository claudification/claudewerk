import { randomUUID } from 'node:crypto'
import type { Conversation, TranscriptSystemEntry } from '../../../shared/protocol'
import type { ConversationStore } from '../../conversation-store'
import { applyTitleWrite } from '../../conversation-store/title-authority'
import { parseRecapContent } from '../shared/json-parse'
import { condenseTranscript } from './condense'
import { sanitizeSuggestedName } from './name'

// fallow-ignore-next-line complexity
export function persistResult(
  store: ConversationStore,
  conversationId: string,
  rawText: string,
  allowEnded: boolean,
): void {
  const parsed = parseRecapContent(rawText)
  const freshConv = store.getConversation(conversationId)
  if (!freshConv) return
  if (!allowEnded && freshConv.status !== 'idle') return

  const suggestedName = sanitizeSuggestedName(parsed.name)
  const entry: TranscriptSystemEntry = {
    type: 'system',
    subtype: 'away_summary',
    content: JSON.stringify({
      title: parsed.title,
      recap: parsed.recap,
      ...(suggestedName ? { name: suggestedName } : {}),
    }),
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
  }
  store.addTranscriptEntries(conversationId, [entry], false)
  applySuggestedName(store, conversationId, freshConv, suggestedName)
  store.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'transcript',
    conversationId,
    entries: [entry],
  })
  store.broadcastConversationUpdate(conversationId)
  if (allowEnded) store.persistConversationById(conversationId)
  console.log(
    `[recap] generated for ${conversationId.slice(0, 8)}: title="${parsed.title}" recap="${parsed.recap.slice(0, 60)}"` +
      (suggestedName ? ` name="${suggestedName}"` : ''),
  )
}

/**
 * Adopt the model-suggested name as the conversation's auto title.
 *
 * Ranked `cc-auto`: a machine-chosen name, so it titles an unclaimed
 * conversation but never overrules a human or an agent. Undated on purpose --
 * the suggestion describes the conversation's whole history, not a moment in
 * it, so it has no meaningful clock to compare against.
 */
function applySuggestedName(
  store: ConversationStore,
  conversationId: string,
  conv: Conversation,
  name: string | null,
): void {
  if (!name) return
  const before = conv.title ?? '(none)'
  const verdict = applyTitleWrite(conv, { title: name, origin: 'cc-auto' }, Date.now())
  if (!verdict.accept) {
    if (verdict.reason !== 'unchanged') {
      console.log(
        `[recap] suggested name "${name}" ignored for ${conversationId.slice(0, 8)} -- ${verdict.reason}, ` +
          `title "${conv.title}" (origin=${conv.titleOrigin ?? '-'}) kept`,
      )
    }
    return
  }
  console.log(`[recap] conversation name: "${before}" -> "${name}" (${conversationId.slice(0, 8)}, auto)`)
  store.persistConversationById(conversationId)
}

export function buildCondensedContext(
  store: ConversationStore,
  conversationId: string,
  resultText?: string,
): string | null {
  let entries = store.getTranscriptEntries(conversationId)
  if (entries.length === 0) entries = store.loadTranscriptFromStore(conversationId, 200) || []
  if (entries.length === 0 && !resultText) return null
  return condenseTranscript({ entries, resultText })
}
