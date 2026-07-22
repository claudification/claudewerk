import { beforeEach, describe, expect, it, vi } from 'vitest'

const updatePrefs = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ updateControlPanelPrefs: updatePrefs }) },
}))

const { runUpdateOrbSettings } = await import('./update-orb-settings')

beforeEach(() => updatePrefs.mockClear())

describe('runUpdateOrbSettings', () => {
  it('clamps an out-of-range speed and persists it', () => {
    const out = runUpdateOrbSettings({ speed: 9 })
    expect(updatePrefs).toHaveBeenCalledWith({ voiceOrbSpeed: 1.5 })
    expect(out.applied).toContain('speed 1.5')
  })

  it('accepts a valid voice (case-insensitive) and persists it', () => {
    const out = runUpdateOrbSettings({ voice: 'Cedar' })
    expect(updatePrefs).toHaveBeenCalledWith({ voiceOrbVoice: 'cedar' })
    expect(out.applied).toContain('voice cedar')
  })

  it('REJECTS an unknown voice and persists NOTHING (voice is lossy)', () => {
    const out = runUpdateOrbSettings({ voice: 'nova' })
    expect(updatePrefs).not.toHaveBeenCalled()
    expect(String((out.rejected as string[])[0])).toContain('nova')
    expect(String((out.rejected as string[])[0])).toContain('marin')
  })

  it('accepts a valid tone with a next-summon note', () => {
    const out = runUpdateOrbSettings({ tone: 'professional' })
    expect(updatePrefs).toHaveBeenCalledWith({ voiceOrbTone: 'professional' })
    expect(String(out.note)).toContain('next summon')
  })

  it('REJECTS an unknown tone', () => {
    const out = runUpdateOrbSettings({ tone: 'evil' })
    expect(updatePrefs).not.toHaveBeenCalled()
    expect(out.rejected).toBeTruthy()
  })

  it('nothing named -> a spoken-friendly error, no write', () => {
    const out = runUpdateOrbSettings({})
    expect(out.error).toBeTruthy()
    expect(updatePrefs).not.toHaveBeenCalled()
  })

  it('applies the valid field and rejects the bad one in the same call', () => {
    const out = runUpdateOrbSettings({ speed: 1.0, voice: 'bogus' })
    expect(updatePrefs).toHaveBeenCalledWith({ voiceOrbSpeed: 1 })
    expect(out.applied).toBeTruthy()
    expect(out.rejected).toBeTruthy()
  })
})
