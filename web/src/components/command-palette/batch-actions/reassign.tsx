import { wsSend } from '@/hooks/use-conversations'
import type { BatchAction, BatchActionRunResult } from './types'
import { runWithConcurrency } from './types'

const CONCURRENCY = 5

interface ReassignInput {
  toProjectUri?: string
  toHostSentinelId?: string | null
  toProfile?: string | null
}

function isReassignInput(x: unknown): x is ReassignInput {
  if (typeof x !== 'object' || x === null) return false
  const r = x as ReassignInput
  return r.toProjectUri !== undefined || r.toHostSentinelId !== undefined || r.toProfile !== undefined
}

export const REASSIGN_ACTION: BatchAction = {
  id: 'reassign',
  label: 'Reassign',
  description: 'Move selected conversations to a different sentinel / project / profile (next launch only)',
  requiresInput: 'reassign',
  // Not destructive: only affects the next launch and can be reassigned back.

  async *run({ ids, batchId, input }) {
    if (!isReassignInput(input)) {
      for (const conversationId of ids) {
        yield { conversationId, ok: false, error: 'No reassign target specified' }
      }
      return
    }

    yield* runWithConcurrency<BatchActionRunResult>(
      ids,
      CONCURRENCY,
      async (conversationId): Promise<BatchActionRunResult> => {
        const payload: Record<string, unknown> = {
          targetConversation: conversationId,
          batchId,
        }
        if (input.toProjectUri !== undefined) payload.toProjectUri = input.toProjectUri
        if (input.toHostSentinelId !== undefined) payload.toHostSentinelId = input.toHostSentinelId
        if (input.toProfile !== undefined) payload.toProfile = input.toProfile

        const ok = wsSend('conversation_reassign', payload)
        return ok
          ? { conversationId, ok: true, detail: 'reassign dispatched' }
          : { conversationId, ok: false, error: 'WebSocket disconnected' }
      },
    )
  },
}
