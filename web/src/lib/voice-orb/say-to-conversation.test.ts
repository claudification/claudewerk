import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendInput = vi.fn(() => true)
let conversationsById: Record<string, unknown> = {}
let selectedConversationId: string | null = null

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ conversationsById, selectedConversationId }) },
  sendInput: (id: string, text: string, opts?: unknown) => sendInput(id, text, opts),
}))
vi.mock('@/lib/slim-conversation', () => ({
  selectConversations: (byId: Record<string, unknown>) => Object.values(byId),
}))

const { runSayToConversation } = await import('./say-to-conversation')

const conv = (id: string, title: string, project = 'claude://d/p/remote-claude', status = 'active') => ({
  id,
  title,
  project,
  status,
})

beforeEach(() => {
  sendInput.mockClear()
  sendInput.mockReturnValue(true)
  selectedConversationId = 'c1'
  conversationsById = {
    c1: conv('c1', 'station bar'),
    c2: conv('c2', 'transcript-perf sweep'),
    c3: conv('c3', 'dead one', 'claude://d/p/arr', 'ended'),
  }
})

describe('the conversation on screen (target: null)', () => {
  it('sends to the selected conversation and reports where it landed', () => {
    const out = runSayToConversation({ message: 'retry the deploy', target: null })
    // Poses as the user, but attributed "from Orb" so the transcript shows it.
    expect(sendInput).toHaveBeenCalledWith('c1', 'retry the deploy', { source: 'Orb' })
    expect(out).toMatchObject({ sent: true, to: 'station bar', conversationId: 'c1' })
  })

  it('refuses with candidates when nothing is open, instead of picking one', () => {
    selectedConversationId = null
    const out = runSayToConversation({ message: 'hello', target: null })
    expect(sendInput).not.toHaveBeenCalled()
    expect(String(out.error)).toContain('no conversation is open')
    expect((out.candidates as unknown[]).length).toBeGreaterThan(0)
  })

  it('refuses when the selection points at an ended conversation', () => {
    selectedConversationId = 'c3'
    const out = runSayToConversation({ message: 'hello', target: null })
    expect(sendInput).not.toHaveBeenCalled()
    expect(out.error).toBeTruthy()
  })
})

describe('a NAMED conversation', () => {
  it('resolves the spoken name against live titles', () => {
    const out = runSayToConversation({ message: 'we are live', target: 'Station Bar' })
    expect(sendInput).toHaveBeenCalledWith('c1', 'we are live', { source: 'Orb' })
    expect(out).toMatchObject({ sent: true, to: 'station bar' })
  })

  it('matches through lost punctuation ("transcript perf")', () => {
    const out = runSayToConversation({ message: 'status?', target: 'transcript perf' })
    expect(out).toMatchObject({ sent: true, conversationId: 'c2' })
  })

  it('SENDS NOTHING when the name is ambiguous -- it asks instead', () => {
    conversationsById = { a: conv('a', 'build it'), b: conv('b', 'build it') }
    selectedConversationId = 'a'
    const out = runSayToConversation({ message: 'go', target: 'build it' })
    expect(sendInput).not.toHaveBeenCalled()
    expect(String(out.error)).toContain('ambiguous')
    expect((out.candidates as unknown[]).length).toBe(2)
  })

  it('SENDS NOTHING when the name matches nothing', () => {
    const out = runSayToConversation({ message: 'go', target: 'kubernetes' })
    expect(sendInput).not.toHaveBeenCalled()
    expect(String(out.error)).toContain('nothing live matches')
  })

  it('never targets an ENDED conversation by name', () => {
    const out = runSayToConversation({ message: 'go', target: 'dead one' })
    expect(sendInput).not.toHaveBeenCalled()
    expect(out.sent).toBeUndefined()
  })
})

describe('guards', () => {
  it('will not send an empty message', () => {
    for (const message of ['', '   ', undefined, 42]) {
      const out = runSayToConversation({ message, target: null })
      expect(String(out.error)).toContain('nothing to send')
    }
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('never claims a delivery the wire refused', () => {
    sendInput.mockReturnValue(false)
    const out = runSayToConversation({ message: 'hi', target: null })
    expect(out.sent).toBeUndefined()
    expect(String(out.error)).toContain('could not reach')
  })
})
