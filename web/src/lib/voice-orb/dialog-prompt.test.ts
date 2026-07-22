import { describe, expect, it } from 'vitest'
import { DIALOG_PROMPT_FLOOR_MS, decideDialogPrompt, type PromptableDialog } from './dialog-prompt'

const dialog = (key: string, over: Partial<PromptableDialog> = {}): PromptableDialog => ({
  kind: 'ask',
  conversationId: 'c1',
  key,
  fieldId: 'Ship it?',
  title: 'Ship',
  question: 'Ship it?',
  conversationTitle: 'station bar',
  options: [
    { value: 'yes', label: 'Ship now' },
    { value: 'no', label: 'Hold' },
  ],
  ...over,
})

const base = { announcedKey: null, orbState: 'listening', lastSpokeAt: 0, now: 1_000_000 }

describe('putting an open question to him', () => {
  it('names the conversation, the question and every option', () => {
    const out = decideDialogPrompt({ ...base, open: [dialog('k1')] })
    expect(out.announced).toBe('k1')
    expect(out.say).toContain('[open question]')
    expect(out.say).toContain('station bar')
    expect(out.say).toContain('Ship it?')
    expect(out.say).toContain('Ship now, Hold')
    // It must be clear that reading it out has not answered anything.
    expect(out.say).toContain('nothing is answered')
  })

  it('caps a long option list so it stays listenable', () => {
    const many = dialog('k1', {
      options: Array.from({ length: 9 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` })),
    })
    expect(decideDialogPrompt({ ...base, open: [many] }).say).toContain('(and 3 more)')
  })

  it('falls back to a short id when the conversation has no name', () => {
    const anon = dialog('k1', { conversationTitle: '', conversationId: 'abcdef123456' })
    expect(decideDialogPrompt({ ...base, open: [anon] }).say).toContain('abcdef12')
  })
})

describe('shutting up', () => {
  it('says nothing when nothing is open', () => {
    expect(decideDialogPrompt({ ...base, open: [] })).toMatchObject({ say: null, reason: 'nothing-open' })
  })

  it('never talks over its own sentence', () => {
    for (const orbState of ['speaking', 'thinking']) {
      expect(decideDialogPrompt({ ...base, open: [dialog('k1')], orbState })).toMatchObject({
        say: null,
        reason: 'orb-busy',
      })
    }
  })

  it('holds the floor between prompts, then lets the next one through', () => {
    const open = [dialog('k1')]
    const now = 1_000_000
    expect(decideDialogPrompt({ ...base, open, lastSpokeAt: now - 1_000, now })).toMatchObject({ reason: 'cooldown' })
    const later = decideDialogPrompt({ ...base, open, lastSpokeAt: now - DIALOG_PROMPT_FLOOR_MS - 1, now })
    expect(later.say).not.toBeNull()
  })

  it('holds the announced key while it is still open, and never stacks a second question', () => {
    const out = decideDialogPrompt({ ...base, open: [dialog('k1'), dialog('k2')], announcedKey: 'k1' })
    expect(out).toMatchObject({ say: null, announced: 'k1', reason: 'waiting' })
  })
})

describe('the cancel rule', () => {
  it('drops the attempt silently when the question it read out is gone', () => {
    // He answered it on screen: no "never mind", just stop waiting on it.
    const out = decideDialogPrompt({ ...base, open: [], announcedKey: 'k1' })
    expect(out).toMatchObject({ say: null, announced: null, reason: 'cleared' })
  })

  it('is then free to put the NEXT question to him', () => {
    const cleared = decideDialogPrompt({ ...base, open: [dialog('k2')], announcedKey: 'k1' })
    expect(cleared.announced).toBeNull()
    const next = decideDialogPrompt({ ...base, open: [dialog('k2')], announcedKey: null })
    expect(next.announced).toBe('k2')
  })
})
