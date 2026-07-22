import { describe, expect, it } from 'bun:test'
import { buildVoiceInstructions } from './voice-persona'
import { asVoiceTone, DEFAULT_VOICE_TONE, tonePreamble, VOICE_TONES } from './voice-tones'
import { ACTIVE_VOICE_TOOLS, VOICE_ACTION_TOOLS, VOICE_READ_TOOLS } from './voice-tools'

const READ = [...VOICE_READ_TOOLS]
const ALL = [...ACTIVE_VOICE_TOOLS]

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
      expect(text).toContain('but ask')
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

  it('has paperwork for MEATBAG and U.S.E.R., on request only', () => {
    const snarky = tonePreamble('snarky')
    expect(snarky).toContain('M.E.A.T.B.A.G.')
    expect(snarky).toContain('Marginally Efficient Autonomous Terminal')
    expect(snarky).toContain('U.S.E.R.')
    expect(snarky).toContain('Unreliable Squishy Executive')
    expect(snarky).toContain('IF HE ASKS')
    expect(snarky).toContain('never volunteer them twice')
    // Professional has no jokes to explain.
    expect(tonePreamble('professional')).not.toContain('M.E.A.T.B.A.G.')
  })

  it('keeps the facts-first rule even at full tilt', () => {
    expect(tonePreamble('overkill')).toContain('facts still come FIRST')
  })

  it('is SCRAPLORD in every tone, professional included', () => {
    for (const tone of VOICE_TONES) expect(tonePreamble(tone)).toContain('SCRAPLORD')
  })

  it('escalates: professional drops the act, overkill goes operatic', () => {
    expect(tonePreamble('professional')).toContain('Drop the')
    expect(tonePreamble('snarky')).toContain('ONE jab per answer')
    expect(tonePreamble('homicidal')).toContain('temporary')
    expect(tonePreamble('overkill')).toContain('profanity permitted')
  })

  it('asks for confirmation ONLY when it had to guess the target', () => {
    const full = buildVoiceInstructions(ALL)
    expect(full).toContain('ON SCREEN needs NONE')
    expect(full).toContain('naming it IS the confirmation')
    expect(full).toContain('ONLY when you had to guess')
  })

  it('teaches the memory verbs, including deleting a mishearing', () => {
    const full = buildVoiceInstructions(ALL)
    expect(full).toContain('`remember`')
    expect(full).toContain('`forget`')
    expect(full).toContain('never recite it')
    expect(buildVoiceInstructions(READ)).not.toContain('`remember`')
  })

  it('clamps LENGTH hard -- one sentence, answer first', () => {
    const full = buildVoiceInstructions(ALL)
    expect(full).toContain('ONE sentence')
    expect(full).toContain('Answer FIRST')
    expect(full).toContain('No preamble')
  })

  it('professional drops the attitude entirely', () => {
    const pro = tonePreamble('professional')
    expect(pro).not.toContain('meatbag')
    expect(pro).toContain('no jokes')
    // ...but not the rule.
    expect(pro).toContain('THE RULE')
  })

  it('homicidal and overkill keep the contempt without touching the work', () => {
    expect(tonePreamble('homicidal')).toContain('meatbag')
    expect(tonePreamble('homicidal')).toContain('never threaten anything you could actually carry out')
    expect(tonePreamble('overkill')).toContain('profanity permitted')
    expect(tonePreamble('overkill')).toContain('facts still come FIRST')
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
