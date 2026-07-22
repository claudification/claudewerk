import { describe, expect, it } from 'bun:test'
import { buildVoiceInstructions } from './voice-persona'
import { VOICE_ACTION_TOOLS, VOICE_READ_TOOLS } from './voice-tools'

describe('buildVoiceInstructions', () => {
  const p0 = buildVoiceInstructions([...VOICE_READ_TOOLS])
  const p2 = buildVoiceInstructions([...VOICE_READ_TOOLS, ...VOICE_ACTION_TOOLS])

  it('never coaches a verb the phase does not mint (P0 is read-only)', () => {
    expect(p0).not.toContain('`dispatch`')
    expect(p0).not.toContain('`dispatch_quest`')
    expect(p0).not.toContain('`confirm_expensive`')
    expect(p0).toContain('`projects_overview`')
    expect(p0).toContain('`control_screen`')
  })

  it('adds the action + cost paragraphs once those tools are minted', () => {
    expect(p2).toContain('`dispatch`')
    expect(p2).toContain('`dispatch_quest`')
    expect(p2).toContain('`confirm_expensive`')
    expect(p2).toContain('COST AWARENESS')
  })

  it('always carries the VOICE IS LOSSY rail and the identity', () => {
    for (const text of [p0, p2, buildVoiceInstructions([])]) {
      expect(text).toContain('VOICE IS LOSSY')
      expect(text).toContain('Jarvis')
    }
  })

  it('speaks the fleet vocabulary', () => {
    expect(p0).toContain('CONVERSATION')
    expect(p0).toContain('SENTINEL')
  })
})
