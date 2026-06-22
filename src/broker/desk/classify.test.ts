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
})
