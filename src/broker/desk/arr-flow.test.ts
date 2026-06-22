/**
 * The §0 ARR SCENARIO, end-to-end at the CODE level (plan B7).
 *
 * Proves the connective tissue of the canonical proof actually connects: a quest
 * dispatched by the dispatcher (steps 2-4) and the worker's report-back re-engaging
 * it (steps 5-6) share ONE pendingId / userId / worker id and drive the
 * <pending> -> <findings> mutation that IS the impulse. The deterministic halves
 * here (no LLM, stubbed spawn) plus the real-token coherence already validated in
 * §1/§8 cover everything except the live spawn + worker web-lookup, which needs a
 * deployed broker + a real `arr` project (Jonas-gated).
 */

import { expect, test } from 'bun:test'
import type { ConversationStore } from '../conversation-store'
import { deliverDispatcherReport } from './async-impulse'
import { getUserHistory, resetUserHistory } from './history-store'
import { getBlock } from './living-history'
import { resolveQuest } from './quest-registry'
import { type QuestSpawn, questTools } from './quest-tool'
import type { DispatchRuntime } from './runtime'

const fakeStore = {} as unknown as ConversationStore
const rt: DispatchRuntime = { store: fakeStore, callerConversationId: null }

test('Arr scenario: dispatch a quest, worker reports back, dispatcher relays (steps 2-6)', async () => {
  resetUserHistory('jonas')

  // ── steps 2-4: the dispatcher sizes the task moderate -> Sonnet worker, hands
  // it the quest, and parks <pending> while answering the user "spawned a worker".
  let workerPrompt = ''
  const spawn: QuestSpawn = async req => {
    workerPrompt = req.intent
    return { conversationId: 'conv_arrworker' }
  }
  const quest = (await questTools(rt, spawn).dispatch_quest.execute(
    {
      project: 'claude://default/Users/jonas/projects/arr',
      task: 'find this week sci-fi or adventure movie releases',
      complexity: 'moderate',
    },
    { identity: { userId: 'jonas' } },
  )) as { conversationId: string; pendingId: string; model: string }

  expect(quest.model).toBe('sonnet') // complexity -> tier
  expect(quest.conversationId).toBe('conv_arrworker')
  // the worker is told to report back to the dispatcher + exit
  expect(workerPrompt).toContain('send_message')
  expect(workerPrompt).toContain('dispatcher')
  // <pending> parked in jonas's living history, quest registered against the worker
  const pending = getBlock(getUserHistory('jonas'), quest.pendingId)
  expect(pending?.tag).toBe('pending')
  expect(resolveQuest('conv_arrworker')).toMatchObject({ userId: 'jonas', pendingId: quest.pendingId })

  // ── steps 5-6: the worker calls send_message(to:"dispatcher") and exits; the
  // sink mutates <pending> -> <findings> (THE IMPULSE) and the dispatcher relays.
  let findingsAtImpulse: string | undefined
  let relayUserId: unknown
  const result = await deliverDispatcherReport(
    fakeStore,
    'conv_arrworker',
    'Dune Part Three (sci-fi); Jungle Run (adventure)',
    {
      runImpulse: async (intent, _rt, opts) => {
        // at impulse time the SAME pending block is now findings with the result
        const f = getBlock(getUserHistory('jonas'), quest.pendingId)
        findingsAtImpulse = f?.tag === 'findings' ? f.content : undefined
        expect(intent).toContain(quest.pendingId) // the impulse points at the block
        return {
          type: 'dispatch_decision',
          decisionId: 'dec_arr',
          intent,
          disposition: 'converse',
          confidence: 1,
          reasoning: 'relay',
          reply: "Arr's back -- Dune Part Three (sci-fi) and Jungle Run (adventure) dropped this week.",
          executed: false,
          traceId: 'trc_arr',
          ts: 1,
          userId: opts.userId,
        }
      },
      broadcast: (_s, msg) => {
        relayUserId = msg.userId
      },
    },
  )

  expect(result.ok).toBe(true)
  expect(findingsAtImpulse).toContain('Dune Part Three') // <pending> became <findings>
  expect(relayUserId).toBe('jonas') // relayed to the right user's overlay
  // findings delivered -> block dropped, quest retired (context stays clean)
  expect(getBlock(getUserHistory('jonas'), quest.pendingId)).toBeUndefined()
  expect(resolveQuest('conv_arrworker')).toBeUndefined()
})
