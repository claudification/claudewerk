import { describe, expect, it } from 'bun:test'
import { buildVoiceInstructions } from './voice-persona'
import { asVoiceTone, DEFAULT_VOICE_TONE, tonePreamble, VOICE_TONES } from './voice-tones'
import { VOICE_ACTION_TOOLS, VOICE_READ_TOOLS } from './voice-tools'

const READ = [...VOICE_READ_TOOLS]
const ALL = [...VOICE_READ_TOOLS, ...VOICE_ACTION_TOOLS]

describe('the contract drives the instructions', () => {
  it('never coaches a verb that is not minted', () => {
    const readOnly = buildVoiceInstructions(READ)
    expect(readOnly).not.toContain('`say_to_conversation`')
    expect(readOnly).not.toContain('`dispatch_quest`')
    expect(readOnly).toContain('`projects_overview`')
    expect(readOnly).toContain('`control_screen`')
  })

  it('adds the talking + quest + cost paragraphs once the action verbs are minted', () => {
    const full = buildVoiceInstructions(ALL)
    expect(full).toContain('`say_to_conversation`')
    expect(full).toContain('`dispatch_quest`')
    expect(full).toContain('COST:')
  })

  it('makes DIRECT talk the main job and forbids routing through the dispatcher', () => {
    const full = buildVoiceInstructions(ALL)
    expect(full).toContain('STRAIGHT to the conversation')
    expect(full).toContain('no routing, no classifier')
    expect(full).toContain('you READ it, you never')
    // And it must acknowledge delivery out loud.
    expect(full).toContain('posted to')
  })

  it('never coaches the routing brain, which is not in the contract at all', () => {
    const full = buildVoiceInstructions(ALL)
    expect(full).not.toContain('`dispatch`')
    expect(full).not.toContain('`conversation_select`')
    expect(full).not.toContain('`confirm_expensive`')
  })

  it('speaks the fleet vocabulary', () => {
    expect(buildVoiceInstructions(READ)).toContain('CONVERSATION')
    expect(buildVoiceInstructions(READ)).toContain('SENTINEL')
  })
})

describe('the safety rails survive every tone', () => {
  it('carries VOICE IS LOSSY and the never-skip-a-confirm rule, always', () => {
    for (const tone of VOICE_TONES) {
      const text = buildVoiceInstructions(ALL, tone)
      expect(text).toContain('VOICE IS LOSSY')
      expect(text).toContain('may never skip one')
      expect(text).toContain('THE RULE')
    }
    // Even with an empty contract, the rails are there.
    expect(buildVoiceInstructions([])).toContain('VOICE IS LOSSY')
  })
})

describe('the tone dial', () => {
  it('defaults to snarky, and snarky is the meatbag persona', () => {
    expect(DEFAULT_VOICE_TONE).toBe('snarky')
    const snarky = buildVoiceInstructions(ALL)
    expect(snarky).toContain('meatbag')
  })

  it('is O.R.B., and the expansion escalates with the dial', () => {
    for (const tone of VOICE_TONES) expect(tonePreamble(tone)).toContain('O.R.B.')
    expect(tonePreamble('snarky')).toContain('Obligatory Remote Babysitter')
    expect(tonePreamble('professional')).toContain('Do not expand it')
    expect(tonePreamble('homicidal')).toContain('Orbital Retribution Buffer')
    expect(tonePreamble('overkill')).toContain('Expand it differently every time')
  })

  it('professional drops the attitude entirely', () => {
    const pro = tonePreamble('professional')
    expect(pro).not.toContain('meatbag')
    expect(pro).toContain('No jokes')
    // ...but not the rule.
    expect(pro).toContain('THE RULE')
  })

  it('homicidal and overkill keep the contempt without touching the work', () => {
    expect(tonePreamble('homicidal')).toContain('meatbag')
    expect(tonePreamble('homicidal')).toContain('never threaten anything you could actually carry out')
    expect(tonePreamble('overkill')).toContain('profanity permitted')
    expect(tonePreamble('overkill')).toContain('answer comes first')
  })

  it('every tone produces a distinct manner', () => {
    const texts = VOICE_TONES.map(t => tonePreamble(t))
    expect(new Set(texts).size).toBe(VOICE_TONES.length)
  })

  it('narrows junk from the wire to the default instead of minting a blank persona', () => {
    for (const junk of [undefined, null, '', 'HOMICIDAL', 'evil', 42, {}]) {
      expect(asVoiceTone(junk)).toBe(DEFAULT_VOICE_TONE)
    }
    expect(asVoiceTone('overkill')).toBe('overkill')
  })
})
