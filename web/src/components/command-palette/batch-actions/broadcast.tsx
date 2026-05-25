import { wsSend } from '@/hooks/use-conversations'
import { runWithConcurrency } from './types'
import type { BatchAction, BatchActionRunResult } from './types'

const CONCURRENCY = 5

export interface BroadcastInput {
  message: string
  /** Optional separate context block forwarded alongside the message. */
  context?: string
}

function isBroadcastInput(x: unknown): x is BroadcastInput {
  return typeof x === 'object' && x !== null && typeof (x as BroadcastInput).message === 'string'
}

export const BROADCAST_ACTION: BatchAction = {
  id: 'broadcast',
  label: 'Broadcast message',
  description: 'Send the same prompt to every selected conversation',
  requiresInput: 'broadcast',

  async *run({ ids, batchId, input }) {
    if (!isBroadcastInput(input) || input.message.trim().length === 0) {
      // Yield one failure per id rather than throwing -- keeps the UI clean.
      for (const conversationId of ids) {
        yield { conversationId, ok: false, error: 'Empty broadcast message' }
      }
      return
    }
    const message = input.message
    const context = input.context

    yield* runWithConcurrency<BatchActionRunResult>(ids, CONCURRENCY, async (conversationId): Promise<BatchActionRunResult> => {
      const ok = wsSend('channel_send', {
        toConversation: conversationId,
        intent: 'notify',
        message,
        ...(context ? { context } : {}),
        batchId,
        conversationId: `${batchId}:${conversationId}`,
      })
      return ok
        ? { conversationId, ok: true, detail: 'broadcast dispatched' }
        : { conversationId, ok: false, error: 'WebSocket disconnected' }
    })
  },
}
