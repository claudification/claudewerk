import { beforeEach, describe, expect, it, vi } from 'vitest'

let prefs: { voiceOrbTone: string } = { voiceOrbTone: 'snarky' }
const updateControlPanelPrefs = vi.fn((patch: { voiceOrbTone?: string }) => {
  prefs = { ...prefs, ...patch } as { voiceOrbTone: string }
})

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ controlPanelPrefs: prefs, updateControlPanelPrefs }) },
}))

const { currentTone, cycleVoiceOrbTone, nextTone, VOICE_ORB_TONES } = await import('./voice-orb-tone')

beforeEach(() => {
  prefs = { voiceOrbTone: 'snarky' }
  updateControlPanelPrefs.mockClear()
})

describe('the tone dial', () => {
  it('cycles through every position and wraps', () => {
    let tone = VOICE_ORB_TONES[0]
    const seen = [tone]
    for (let i = 1; i < VOICE_ORB_TONES.length; i++) {
      tone = nextTone(tone)
      seen.push(tone)
    }
    expect(seen).toEqual([...VOICE_ORB_TONES])
    expect(nextTone(tone)).toBe(VOICE_ORB_TONES[0])
  })

  it('persists the new position', () => {
    const landed = cycleVoiceOrbTone()
    expect(updateControlPanelPrefs).toHaveBeenCalledWith({ voiceOrbTone: landed })
    expect(currentTone()).toBe(landed)
  })

  it('falls back to snarky when the stored value is junk', () => {
    prefs = { voiceOrbTone: 'unhinged' }
    expect(currentTone()).toBe('snarky')
  })

  it('announces the change, and says it applies on the next summon', () => {
    const events: CustomEvent[] = []
    window.addEventListener('rclaude-toast', e => events.push(e as CustomEvent))
    const landed = cycleVoiceOrbTone()
    expect(events).toHaveLength(1)
    expect(events[0]?.detail.title).toContain(landed)
    expect(events[0]?.detail.body).toContain('next summon')
  })
})
