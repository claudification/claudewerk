import { describe, expect, test } from 'bun:test'
import type { ConversationStore } from '../conversation-store'
import { getUserHistory, resetUserHistory } from './history-store'
import { getBlock } from './living-history'
import { questModel } from './model-config'
import { questCount, resolveQuest } from './quest-registry'
import { type QuestSpawn, questTools } from './quest-tool'
import type { DispatchRuntime } from './runtime'
import type { ToolContext } from './tool-def'

const fakeRt = { store: {} as unknown as ConversationStore, callerConversationId: null } as DispatchRuntime
const ctx: ToolContext = { identity: { userId: 'jonas' } }

describe('questModel (complexity -> tier)', () => {
  test('maps complexity to CC model aliases', () => {
    expect(questModel('simple')).toBe('haiku')
    expect(questModel('moderate')).toBe('sonnet')
    expect(questModel('complex')).toBe('opus')
  })
})

describe('dispatch_quest tool', () => {
  test('unknown project -> clean error, no spawn', async () => {
    let spawned = false
    const spawn: QuestSpawn = async () => {
      spawned = true
      return { conversationId: 'c' }
    }
    const tools = questTools(fakeRt, spawn)
    const out = (await tools.dispatch_quest.execute({ project: 'nope-xyz', task: 'x', complexity: 'simple' }, ctx)) as {
      error?: string
    }
    expect(out.error).toContain('no project matching')
    expect(spawned).toBe(false)
  })

  test('happy path: spawns on the complexity tier, registers the quest, parks <pending>', async () => {
    resetUserHistory('jonas')
    let sawModel: string | undefined
    let sawProjectUri: string | undefined
    const spawn: QuestSpawn = async req => {
      sawModel = req.model
      sawProjectUri = req.projectUri // we dispatch BY URI, never a raw path
      // the worker is told to report back to the dispatcher and exit
      expect(req.intent).toContain('send_message')
      expect(req.intent).toContain('dispatcher')
      expect(req.intent).toContain('exit_conversation')
      return { conversationId: 'conv_worker123' }
    }
    const tools = questTools(fakeRt, spawn)
    // A full path-backed URI resolves to a routable project without a store.
    const out = (await tools.dispatch_quest.execute(
      {
        project: 'claude://default/Users/jonas/projects/arr',
        task: 'find this week sci-fi releases',
        complexity: 'moderate',
      },
      ctx,
    )) as { conversationId?: string; pendingId?: string; model?: string }

    expect(sawModel).toBe('sonnet') // moderate -> Sonnet
    expect(sawProjectUri).toBe('claude://default/Users/jonas/projects/arr') // dispatched BY URI
    expect(out.conversationId).toBe('conv_worker123')
    expect(out.model).toBe('sonnet')
    // quest registered against the worker, keyed for the report-back
    expect(resolveQuest('conv_worker123')).toMatchObject({ userId: 'jonas', intent: 'find this week sci-fi releases' })
    // a <pending> block parked in the user's history under the returned id
    const pending = getBlock(getUserHistory('jonas'), out.pendingId as string)
    expect(pending?.tag).toBe('pending')
    expect(pending?.content).toContain('find this week sci-fi releases')
    expect(questCount()).toBeGreaterThan(0)
  })
})
