import { wsSend } from '@/hooks/use-conversations'
import { runWithConcurrency } from './types'
import type { BatchAction, BatchActionRunResult } from './types'

const CONCURRENCY = 5

export const INTERRUPT_ACTION: BatchAction = {
  id: 'interrupt',
  label: 'Interrupt',
  description: 'Cancel the current turn on each selected conversation',

  async *run({ ids, batchId }) {
    yield* runWithConcurrency<BatchActionRunResult>(ids, CONCURRENCY, async (conversationId): Promise<BatchActionRunResult> => {
      const ok = wsSend('conversation_control', {
        targetConversation: conversationId,
        action: 'interrupt',
        batchId,
      })
      return ok
        ? { conversationId, ok: true, detail: 'interrupt sent' }
        : { conversationId, ok: false, error: 'WebSocket disconnected' }
    })
  },
}
