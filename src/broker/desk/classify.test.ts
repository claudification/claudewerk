import { describe, expect, it } from 'bun:test'
import type { ChatResponse } from '../recap/shared/openrouter-client'
import { type ChatFn, classifyDispatch, type DispatchRosterEntry } from './classify'

function mockChat(decision: unknown): ChatFn {
  return async () =>
    ({
      content: JSON.stringify(decision),
      raw: {},
      usage: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 } as never,
      model: 'mock',
    }) as ChatResponse
}

const throwingChat: ChatFn = async () => {
  throw new Error('network down')
}

const roster: DispatchRosterEntry[] = [
  { conversationId: 'conv_mic', project: 'rc', title: 'mic bug', idleMs: 60_000, contextTokens: 30_000 },
  { conversationId: 'conv_old', project: 'rc', title: 'old thing', ended: true, contextTokens: 200_000, model: 'opus' },
]

describe('classifyDispatch -- override-first', () => {
  it('honors an explicit disposition hint without calling the LLM', async () => {
    let called = false
    const chat: ChatFn = async () => {
      called = true
      throw new Error('should not be called')
    }
    const r = await classifyDispatch({ intent: 'x', dispositionHint: 'new', roster }, chat)
    expect(r.disposition).toBe('new')
    expect(r.confidence).toBe(1)
    expect(called).toBe(false)
  })

  it('explicit live target -> route (with cost)', async () => {
    const r = await classifyDispatch({ intent: 'x', target: 'conv_mic', roster }, throwingChat)
    expect(r.disposition).toBe('route')
    expect(r.target).toBe('conv_mic')
    expect(r.cost?.tier).toBe('cheap')
  })

  it('explicit ended target -> revive', async () => {
    const r = await classifyDispatch({ intent: 'x', target: 'conv_old', roster }, throwingChat)
    expect(r.disposition).toBe('revive')
    expect(r.cost?.tier).toBe('very_expensive') // 200k + opus
  })

  it('unknown target -> treated as project -> new', async () => {
    const r = await classifyDispatch({ intent: 'x', target: 'yemaya', roster }, throwingChat)
    expect(r.disposition).toBe('new')
    expect(r.target).toBe('yemaya')
  })
})

describe('classifyDispatch -- LLM path', () => {
  it('routes when the model is confident', async () => {
    const chat = mockChat({ disposition: 'route', target: 'conv_mic', confidence: 0.9, reasoning: 'matches mic' })
    const r = await classifyDispatch({ intent: 'fix the mic bug', roster }, chat)
    expect(r.disposition).toBe('route')
    expect(r.target).toBe('conv_mic')
    expect(r.cost?.tier).toBe('cheap')
  })

  it('spawns new', async () => {
    const chat = mockChat({ disposition: 'new', target: null, confidence: 0.8, reasoning: 'new topic' })
    const r = await classifyDispatch({ intent: 'start a blog', roster }, chat)
    expect(r.disposition).toBe('new')
  })

  it('low confidence -> ask, with candidate cards', async () => {
    const chat = mockChat({ disposition: 'route', target: 'conv_mic', confidence: 0.3, reasoning: 'unsure' })
    const r = await classifyDispatch({ intent: 'something vague', roster }, chat)
    expect(r.disposition).toBe('ask')
    expect(r.candidates?.length).toBe(2)
    expect(r.candidates?.[0]?.commentary).toBeTruthy()
  })

  it('model names an unknown target -> degrades to ask', async () => {
    const chat = mockChat({ disposition: 'route', target: 'conv_ghost', confidence: 0.95, reasoning: 'x' })
    const r = await classifyDispatch({ intent: 'x', roster }, chat)
    expect(r.disposition).toBe('ask')
  })

  it('model says ask directly', async () => {
    const chat = mockChat({ disposition: 'ask', target: null, confidence: 0.9, reasoning: 'two close matches' })
    const r = await classifyDispatch({ intent: 'x', roster }, chat)
    expect(r.disposition).toBe('ask')
  })

  it('LLM failure -> ask (never silently misroute)', async () => {
    const r = await classifyDispatch({ intent: 'x', roster }, throwingChat)
    expect(r.disposition).toBe('ask')
    expect(r.reasoning).toContain('classifier unavailable')
  })

  it('bad JSON from model -> ask', async () => {
    const chat: ChatFn = async () =>
      ({ content: 'not json', raw: {}, usage: {} as never, model: 'mock' }) as ChatResponse
    const r = await classifyDispatch({ intent: 'x', roster }, chat)
    expect(r.disposition).toBe('ask')
  })

  it('parses markdown-fenced JSON (Haiku wraps it in ```json)', async () => {
    const chat: ChatFn = async () =>
      ({
        content: '```json\n{"disposition":"route","target":"conv_mic","confidence":0.9,"reasoning":"mic"}\n```',
        raw: {},
        usage: {} as never,
        model: 'mock',
      }) as ChatResponse
    const r = await classifyDispatch({ intent: 'fix the mic', roster }, chat)
    expect(r.disposition).toBe('route')
    expect(r.target).toBe('conv_mic')
  })

  it('parses JSON embedded in prose', async () => {
    const chat: ChatFn = async () =>
      ({
        content:
          'Sure! Here is my decision: {"disposition":"new","target":null,"confidence":0.8,"reasoning":"new"} ok?',
        raw: {},
        usage: {} as never,
        model: 'mock',
      }) as ChatResponse
    const r = await classifyDispatch({ intent: 'blog', roster }, chat)
    expect(r.disposition).toBe('new')
  })
})

describe('classifyDispatch -- active conversation cost override', () => {
  const activeRoster: DispatchRosterEntry[] = [
    {
      conversationId: 'conv_hot',
      project: 'rc',
      title: 'active big opus',
      isActive: true,
      contextTokens: 269_000,
      model: 'opus',
      idleMs: 5_000,
    },
    {
      conversationId: 'conv_idle',
      project: 'rc',
      title: 'idle big opus',
      contextTokens: 200_000,
      model: 'opus',
      idleMs: 60_000,
    },
    {
      conversationId: 'conv_dead',
      project: 'rc',
      title: 'ended big',
      ended: true,
      contextTokens: 200_000,
      model: 'opus',
    },
  ]

  it('explicit active 269k Opus target = route with cheap cost', async () => {
    const r = await classifyDispatch({ intent: 'x', target: 'conv_hot', roster: activeRoster }, throwingChat)
    expect(r.disposition).toBe('route')
    expect(r.cost?.tier).toBe('cheap')
  })

  it('explicit idle 200k Opus target = route with very_expensive cost', async () => {
    const r = await classifyDispatch({ intent: 'x', target: 'conv_idle', roster: activeRoster }, throwingChat)
    expect(r.disposition).toBe('route')
    expect(r.cost?.tier).toBe('very_expensive')
  })

  it('explicit ended 200k Opus target = revive with very_expensive cost', async () => {
    const r = await classifyDispatch({ intent: 'x', target: 'conv_dead', roster: activeRoster }, throwingChat)
    expect(r.disposition).toBe('revive')
    expect(r.cost?.tier).toBe('very_expensive')
  })

  it('ask candidates show correct commentary for active vs idle', async () => {
    const chat = mockChat({ disposition: 'route', target: 'conv_hot', confidence: 0.2, reasoning: 'unsure' })
    const r = await classifyDispatch({ intent: 'vague', roster: activeRoster }, chat)
    expect(r.disposition).toBe('ask')
    const hot = r.candidates?.find(c => c.conversationId === 'conv_hot')
    const idle = r.candidates?.find(c => c.conversationId === 'conv_idle')
    expect(hot?.cost?.tier).toBe('cheap')
    expect(idle?.cost?.tier).toBe('very_expensive')
  })
})

describe('classifyDispatch -- converse', () => {
  it('passes a converse decision through (the concierge answers directly)', async () => {
    const r = await classifyDispatch(
      { intent: "what's going on today?", roster },
      mockChat({ disposition: 'converse', target: null, confidence: 0.9, reasoning: 'greeting' }),
    )
    expect(r.disposition).toBe('converse')
    expect(r.candidates).toBeUndefined()
  })

  it('does NOT gate converse to ask on low confidence (a greeting is not a routing ambiguity)', async () => {
    const r = await classifyDispatch(
      { intent: 'hey', roster },
      mockChat({ disposition: 'converse', target: null, confidence: 0.1, reasoning: 'chit-chat' }),
    )
    expect(r.disposition).toBe('converse')
  })
})
