import { describe, expect, it } from 'bun:test'
import type { Conversation, HookEvent, HookEventOf, HookEventType } from '../../shared/protocol'
import { addEvent } from './add-event'
import { handleSessionStart } from './event-handlers/session-start'
import { makeTestContext } from './test-context'

function makeConv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_parent',
    project: 'claude://x/y',
    status: 'active',
    events: [],
    subagents: [],
    teammates: [],
    stats: { toolCallCount: 0 },
    ...over,
  } as unknown as Conversation
}

function ctxFor(conv: Conversation) {
  return makeTestContext({ conversations: new Map([[conv.id, conv]]) })
}

function hook(hookEvent: HookEventType, data: Record<string, unknown>, subagentId?: string): HookEvent {
  return {
    type: 'hook',
    conversationId: 'conv_parent',
    hookEvent,
    timestamp: 1,
    data: { session_id: 'p', ...data },
    ...(subagentId ? { subagentId } : {}),
  } as HookEvent
}

function sessionStart(model: string): HookEventOf<'SessionStart'> {
  return {
    type: 'hook',
    conversationId: 'conv_parent',
    hookEvent: 'SessionStart',
    timestamp: 1,
    data: { session_id: 's', model },
  } as HookEventOf<'SessionStart'>
}

describe('subagent hook containment (broker dispatch gate)', () => {
  it('a subagent-originated SessionStart does NOT clobber the parent model (the reported bug)', () => {
    const conv = makeConv({ model: 'claude-fable-5' })
    addEvent(
      ctxFor(conv),
      conv.id,
      hook('SessionStart', { model: 'claude-sonnet-4-6', transcript_path: '/x.jsonl' }, 'a1'),
    )
    expect(conv.model).toBe('claude-fable-5')
  })

  it('a subagent-originated PreCompact does NOT flip parent compacting; a parent PreCompact does', () => {
    const conv = makeConv({ compacting: false })
    const ctx = ctxFor(conv)
    addEvent(ctx, conv.id, hook('PreCompact', { trigger: 'auto' }, 'a1'))
    expect(conv.compacting).toBeFalsy()
    addEvent(ctx, conv.id, hook('PreCompact', { trigger: 'auto' }))
    expect(conv.compacting).toBe(true)
  })

  it('a subagent-originated PostCompact does NOT clear parent compacting', () => {
    const conv = makeConv({ compacting: true })
    addEvent(ctxFor(conv), conv.id, hook('PostCompact', {}, 'a1'))
    expect(conv.compacting).toBe(true)
  })

  it('a subagent tool hook does NOT flip the parent from idle to active', () => {
    const conv = makeConv({ status: 'idle' })
    addEvent(ctxFor(conv), conv.id, hook('PreToolUse', { tool_name: 'Read', tool_input: {} }, 'a1'))
    expect(conv.status).toBe('idle')
  })

  it('a parent SessionStart still establishes the model on first boot', () => {
    const conv = makeConv({})
    addEvent(ctxFor(conv), conv.id, hook('SessionStart', { model: 'claude-fable-5' }))
    expect(conv.model).toBe('claude-fable-5')
  })

  it('routes a subagent event into the matching running roster bucket', () => {
    const conv = makeConv({
      subagents: [{ agentId: 'a1', agentType: 'Explore', status: 'running', startedAt: 0, events: [] }],
    } as unknown as Partial<Conversation>)
    const event = hook('PostToolUse', { tool_name: 'Read' }, 'a1')
    addEvent(ctxFor(conv), conv.id, event)
    expect(conv.subagents[0].events).toContain(event)
  })
})

describe('handleSessionStart model guard (defense-in-depth)', () => {
  it('keeps an already-established model -- SessionStart is a fallback, not ground truth', () => {
    const conv = { model: 'claude-fable-5' } as Conversation
    handleSessionStart(conv, sessionStart('claude-sonnet-4-6'))
    expect(conv.model).toBe('claude-fable-5')
  })

  it('sets the model when none is established yet', () => {
    const conv = {} as Conversation
    handleSessionStart(conv, sessionStart('claude-sonnet-4-6'))
    expect(conv.model).toBe('claude-sonnet-4-6')
  })
})
