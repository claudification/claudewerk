import { wsSend } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import type { BatchAction, BatchActionRunResult } from './types'
import { runWithConcurrency } from './types'

const CONCURRENCY = 5

/** Terminate (or dismiss) per-conv. Active/idle conversations get the
 *  `terminate_conversation` wire message; already-ended ones get the
 *  DELETE /conversations/:id HTTP route. batchId rides on both so a single
 *  grep correlates the full fan-out. */
export const TERMINATE_ACTION: BatchAction = {
  id: 'terminate',
  label: 'Terminate',
  description: 'End live conversations + dismiss ended ones',
  needsConfirm: true,

  async *run({ ids, conversations, batchId }) {
    const byId = new Map(conversations.map((c: Conversation) => [c.id, c]))

    yield* runWithConcurrency<BatchActionRunResult>(
      ids,
      CONCURRENCY,
      async (conversationId): Promise<BatchActionRunResult> => {
        const conv = byId.get(conversationId)
        if (!conv) return { conversationId, ok: false, error: 'Conversation not in store' }

        if (conv.status === 'ended') {
          const url = `/conversations/${encodeURIComponent(conversationId)}?batchId=${encodeURIComponent(batchId)}`
          try {
            const res = await fetch(url, { method: 'DELETE' })
            if (!res.ok) {
              const body = await res.text().catch(() => '')
              return { conversationId, ok: false, error: `HTTP ${res.status}: ${body.slice(0, 120)}` }
            }
            return { conversationId, ok: true, detail: 'dismissed' }
          } catch (err) {
            return { conversationId, ok: false, error: err instanceof Error ? err.message : 'Network error' }
          }
        }

        const ok = wsSend('terminate_conversation', {
          conversationId,
          source: 'dashboard-other',
          batchId,
        })
        return ok
          ? { conversationId, ok: true, detail: 'terminate sent' }
          : { conversationId, ok: false, error: 'WebSocket disconnected' }
      },
    )
  },
}
