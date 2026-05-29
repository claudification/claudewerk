import { describe, expect, it } from 'bun:test'
import type { Conversation, HookEventOf, TranscriptAgentLaunchEntry } from '../../../shared/protocol'
import { createStore } from '../../store'
import type { StoreDriver } from '../../store/types'
import type { ConversationStoreContext } from '../event-context'
import { makeStoreBackedContext } from '../test-context'
import { handlePreToolUse } from './pre-tool-use'
import { handleSubagentStart } from './subagent'

/** Fresh memory store + registered conversation + store-backed context. */
function setup(): { conv: Conversation; ctx: ConversationStoreContext; driver: StoreDriver } {
  const driver = createStore({ type: 'memory' })
  driver.init()
  const conv = { subagents: [], teammates: [] } as unknown as Conversation
  return { conv, driver, ctx: makeStoreBackedContext(driver, 'c1', conv) }
}

function preToolUse(input: Record<string, unknown>): HookEventOf<'PreToolUse'> {
  return {
    type: 'hook',
    conversationId: 'c1',
    hookEvent: 'PreToolUse',
    timestamp: 1000,
    data: { session_id: 's', tool_name: 'Agent', tool_input: input },
  } as HookEventOf<'PreToolUse'>
}

function subagentStart(agentId: string, agentType?: string): HookEventOf<'SubagentStart'> {
  return {
    type: 'hook',
    conversationId: 'c1',
    hookEvent: 'SubagentStart',
    timestamp: 2000,
    data: { session_id: 's', agent_id: agentId, agent_type: agentType },
  } as HookEventOf<'SubagentStart'>
}

describe('agent launch metadata capture (Checkpoint B)', () => {
  it('splits cheap fields to the roster card and big prompt/args to the sub-stream', () => {
    const { conv, ctx, driver } = setup()

    handlePreToolUse(
      ctx,
      'c1',
      conv,
      preToolUse({
        description: 'do the thing',
        subagent_type: 'Explore',
        model: 'opus',
        prompt: 'A very long mission prompt about exploring everything',
        isolation: 'worktree',
        run_in_background: true,
      }),
    )
    // SubagentStart with no agent_type -- the card must fall back to the
    // captured subagent_type.
    handleSubagentStart(ctx, 'c1', conv, subagentStart('agent-x'))

    // Cheap fields on the roster card; the prompt is NOT on the card.
    const card = conv.subagents[0]
    expect(card.agentId).toBe('agent-x')
    expect(card.agentType).toBe('Explore')
    expect(card.model).toBe('opus')
    expect(card.description).toBe('do the thing')
    expect((card as unknown as Record<string, unknown>).prompt).toBeUndefined()

    // Big prompt + bulky args persisted to the agent sub-stream (durable + FTS).
    const stored = driver.transcripts.getLatest('c1', 10, 'agent-x')
    expect(stored).toHaveLength(1)
    const launch = stored[0].content as unknown as TranscriptAgentLaunchEntry
    expect(launch.type).toBe('agent_launch')
    expect(launch.prompt).toBe('A very long mission prompt about exploring everything')
    expect(launch.args).toEqual({ isolation: 'worktree', run_in_background: true })
    // And it is full-text searchable by its mission.
    const hits = driver.transcripts.search('exploring', { conversationId: 'c1' })
    expect(hits.some(h => (h.content as unknown as TranscriptAgentLaunchEntry).prompt?.includes('exploring'))).toBe(
      true,
    )
  })

  it('explicit agent_type from SubagentStart wins over the captured subagent_type', () => {
    const { conv, ctx } = setup()

    handlePreToolUse(ctx, 'c1', conv, preToolUse({ subagent_type: 'Explore', prompt: 'p' }))
    handleSubagentStart(ctx, 'c1', conv, subagentStart('agent-y', 'code-reviewer'))

    expect(conv.subagents[0].agentType).toBe('code-reviewer')
  })

  it('no launch entry when there is no prompt and no bulky args', () => {
    const { conv, ctx, driver } = setup()

    // description-only launch (the legacy shape) -- card still gets the
    // description, but nothing big to persist into the sub-stream.
    handlePreToolUse(ctx, 'c1', conv, preToolUse({ description: 'tiny' }))
    handleSubagentStart(ctx, 'c1', conv, subagentStart('agent-z'))

    expect(conv.subagents[0].description).toBe('tiny')
    expect(driver.transcripts.count('c1', 'agent-z')).toBe(0)
  })

  it('parallel launches FIFO-match their SubagentStarts', () => {
    const { conv, ctx, driver } = setup()

    handlePreToolUse(ctx, 'c1', conv, preToolUse({ description: 'first', prompt: 'p1' }))
    handlePreToolUse(ctx, 'c1', conv, preToolUse({ description: 'second', prompt: 'p2' }))
    handleSubagentStart(ctx, 'c1', conv, subagentStart('a1'))
    handleSubagentStart(ctx, 'c1', conv, subagentStart('a2'))

    expect(conv.subagents.map(a => a.description)).toEqual(['first', 'second'])
    expect(
      (driver.transcripts.getLatest('c1', 1, 'a1')[0].content as unknown as TranscriptAgentLaunchEntry).prompt,
    ).toBe('p1')
    expect(
      (driver.transcripts.getLatest('c1', 1, 'a2')[0].content as unknown as TranscriptAgentLaunchEntry).prompt,
    ).toBe('p2')
  })
})
