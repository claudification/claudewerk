import { describe, expect, it } from 'bun:test'
import type { DispatchThread } from '../../shared/protocol'
import { briefFallback, generateBriefing } from './brief'
import type { ChatFn, DispatchRosterEntry } from './classify'

function capturingChat(reply: string): { chat: ChatFn; seen: { system?: string; user?: string } } {
  const seen: { system?: string; user?: string } = {}
  const chat: ChatFn = async req => {
    seen.system = req.system
    seen.user = req.user
    return { content: reply, raw: {}, usage: {} as never, model: 'mock' } as never
  }
  return { chat, seen }
}

const roster: DispatchRosterEntry[] = [
  { conversationId: 'c1', project: 'rc', title: 'mic bug', idleMs: 120_000, liveState: 'working' },
  { conversationId: 'c2', project: 'rc', title: 'old', ended: true },
]
const threads: DispatchThread[] = [
  { id: 't1', title: 'voice', summary: 'wiring realtime', conversations: [], createdAt: 0, updatedAt: 0 },
]

describe('generateBriefing', () => {
  it('grounds the prompt in roster + threads and returns the trimmed reply', async () => {
    const { chat, seen } = capturingChat('  You have the mic bug in progress.  ')
    const out = await generateBriefing({ intent: "what's up?", roster, threads }, chat)
    expect(out).toBe('You have the mic bug in progress.')
    expect(seen.user).toContain("what's up?")
    expect(seen.user).toContain('mic bug')
    expect(seen.user).toContain('voice') // a thread title
    expect(seen.system).toContain('concierge')
  })
})

describe('briefFallback', () => {
  it('invites the user to start when nothing is active', () => {
    expect(briefFallback([])).toContain("Nothing's on my desk")
  })
  it('counts only live conversations', () => {
    expect(briefFallback(roster)).toContain('1 active conversation')
  })
})
