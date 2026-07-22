import { beforeEach, describe, expect, it, vi } from 'vitest'

const selectConversation = vi.fn()
const closeModal = vi.fn()
let conversationsById: Record<string, unknown> = {}
let modalRecords: Record<string, unknown> = {}

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ conversationsById, selectConversation, selectedConversationId: null }) },
  sendInput: () => true,
}))
vi.mock('@/hooks/use-modal-manager', () => ({
  useModalManagerStore: { getState: () => ({ records: modalRecords, close: closeModal }) },
}))
vi.mock('@/lib/slim-conversation', () => ({
  selectConversations: (byId: Record<string, unknown>) => Object.values(byId),
}))

const { runControlScreen } = await import('./control-screen')

const conv = (id: string, title: string, project = 'claude://default/p/remote-claude', status = 'active') => ({
  id,
  title,
  project,
  status,
})

beforeEach(() => {
  selectConversation.mockClear()
  closeModal.mockClear()
  modalRecords = {}
  conversationsById = {
    c1: conv('c1', 'transcript-perf sweep'),
    c2: conv('c2', 'voice orb build', 'claude://default/p/arr'),
    c3: conv('c3', 'dead one', 'claude://default/p/arr', 'ended'),
  }
})

describe('navigate', () => {
  it('selects on an exact conversation id', () => {
    expect(runControlScreen({ action: 'navigate', target: 'c2' })).toMatchObject({
      navigated: { conversationId: 'c2' },
    })
    expect(selectConversation).toHaveBeenCalledWith('c2', 'voice-orb')
  })

  it('matches a spoken title, punctuation and case included', () => {
    expect(runControlScreen({ action: 'navigate', target: 'Transcript Perf' })).toMatchObject({
      navigated: { conversationId: 'c1' },
    })
  })

  it('never lands on an ENDED conversation', () => {
    const out = runControlScreen({ action: 'navigate', target: 'dead one' })
    expect(out.navigated).toBeUndefined()
    expect(selectConversation).not.toHaveBeenCalled()
  })

  it('ASKS instead of guessing when two candidates tie', () => {
    conversationsById = { a: conv('a', 'build the thing'), b: conv('b', 'build the thing') }
    const out = runControlScreen({ action: 'navigate', target: 'build the thing' })
    expect(String(out.error)).toContain('ambiguous')
    expect((out.candidates as unknown[]).length).toBe(2)
    expect(selectConversation).not.toHaveBeenCalled()
  })

  it('returns candidates when nothing matches, so the orb can offer options', () => {
    const out = runControlScreen({ action: 'navigate', target: 'kubernetes' })
    expect(String(out.error)).toContain('nothing live matches')
    expect((out.candidates as unknown[]).length).toBeGreaterThan(0)
  })

  it('rejects an empty target', () => {
    expect(String(runControlScreen({ action: 'navigate', target: '  ' }).error)).toContain('no conversation named')
  })
})

describe('modals', () => {
  it('closes the most recently opened one', () => {
    modalRecords = {
      old: { id: 'old', title: 'Old', openedAt: 1 },
      fresh: { id: 'fresh', title: 'Fresh', openedAt: 2 },
    }
    expect(runControlScreen({ action: 'close_modal' })).toEqual({ closed: 'Fresh' })
    expect(closeModal).toHaveBeenCalledWith('fresh')
  })

  it('says so when there is nothing open', () => {
    expect(runControlScreen({ action: 'close_modal' })).toMatchObject({ closed: null })
  })

  it('lists what it CAN open when asked for an unknown modal', () => {
    const out = runControlScreen({ action: 'open_modal', target: 'the nuclear codes' })
    expect(String(out.error)).toContain('no modal called')
    expect(out.openable).toEqual(['dispatcher'])
  })
})

describe('bad input', () => {
  it('names the actions it accepts rather than throwing', () => {
    for (const args of [{}, { action: 'terminate' }, { action: 42 }]) {
      const out = runControlScreen(args)
      expect(String(out.error)).toContain('unknown screen action')
      expect(out.actions).toEqual(['navigate', 'open_modal', 'close_modal'])
    }
  })
})
