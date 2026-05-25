import { wsSend } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import type { BatchAction, BatchActionRunResult } from './types'
import { runWithConcurrency } from './types'

const CONCURRENCY = 5

function tzGuess(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** Recap action: fire recap_create per-conv with a current-day period.
 *  Broker handles dedup + caching; we just need to spread the calls. */
export const RECAP_ACTION: BatchAction = {
  id: 'recap',
  label: 'Recap',
  description: 'Generate recaps for the selected conversations',

  async *run({ ids, conversations, batchId }) {
    const byId = new Map(conversations.map((c: Conversation) => [c.id, c]))
    // Use 'today' -- the broker resolves start/end against the caller's tz.
    const period = { label: 'today' } as const

    yield* runWithConcurrency<BatchActionRunResult>(
      ids,
      CONCURRENCY,
      async (conversationId): Promise<BatchActionRunResult> => {
        const conv = byId.get(conversationId)
        if (!conv) return { conversationId, ok: false, error: 'Conversation not in store' }
        const ok = wsSend('recap_create', {
          projectUri: conv.project,
          period,
          timeZone: tzGuess(),
          batchId,
          requestId: `${batchId}:${conversationId}`,
        })
        return ok
          ? { conversationId, ok: true, detail: 'recap dispatched' }
          : { conversationId, ok: false, error: 'WebSocket disconnected' }
      },
    )
  },
}
