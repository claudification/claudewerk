import { describe, expect, it } from 'bun:test'
import { buildVoiceInstructions } from './voice-persona'
import { asVoiceTone, DEFAULT_VOICE_TONE, tonePreamble, VOICE_TONES } from './voice-tones'
import { ACTIVE_VOICE_TOOLS, VOICE_READ_TOOLS } from './voice-tools'

/** The prompt is ONE string to the model -- where it wraps is incidental, so
 *  assertions must not be hostage to it. Flatten before matching. */
const flat = (text: string) => text.replace(/\s+/g, ' ')

const READ = [...VOICE_READ_TOOLS]
const ALL = [...ACTIVE_VOICE_TOOLS]

describe('the contract drives the instructions', () => {
  it('never coaches a verb that is not minted', () => {
    const readOnly = buildVoiceInstructions(READ)
    expect(flat(readOnly)).not.toContain('`say_to_conversation`')
    expect(flat(readOnly)).not.toContain('`dispatch_quest`')
    expect(flat(readOnly)).toContain('`projects_overview`')
    expect(flat(readOnly)).toContain('`control_screen`')
  })

  it('teaches reading how a conversation ENDED, only when read_transcript is minted', () => {
    expect(flat(buildVoiceInstructions(['list_conversations']))).not.toContain('`read_transcript`')
    const withIt = flat(buildVoiceInstructions([...READ, 'read_transcript']))
    expect(withIt).toContain('`read_transcript`')
    expect(withIt).toContain('how did that end')
    // The SMART-status rule: trust the broker fields over the hand-set report,
    // and resolve which conversation before answering (never the last one).
    expect(withIt).toContain('`waitingFor`')
    expect(withIt).toContain('do not just')
    expect(withIt).toContain('NEVER the')
    // Reading a transcript ALOUD is the failure mode this tool invites.
    expect(withIt).toContain('never read a transcript out')
  })

  it('adds the talking + quest + cost paragraphs once the action verbs are minted', () => {
    const full = buildVoiceInstructions(ALL)
    expect(flat(full)).toContain('`say_to_conversation`')
    expect(flat(full)).toContain('`dispatch_quest`')
    expect(flat(full)).toContain('COST:')
  })

  it('teaches answering an open question ONLY when answer_dialog is minted', () => {
    expect(flat(buildVoiceInstructions(READ))).not.toContain('`answer_dialog`')
    const full = flat(buildVoiceInstructions(ALL))
    expect(full).toContain('[open question]')
    expect(full).toContain('`answer_dialog`')
    // The refusal is the point: options back means it submitted NOTHING.
    expect(full).toContain('NOTHING was sent')
  })

  it('makes DIRECT talk the main job and forbids routing through the dispatcher', () => {
    const full = buildVoiceInstructions(ALL)
    expect(flat(full)).toContain('STRAIGHT to the conversation')
    expect(flat(full)).toContain('no routing, no classifier')
    expect(flat(full)).toContain('you READ it, you never')
    // And it must acknowledge delivery out loud -- one word, per the length rule.
    expect(flat(full)).toContain('Then: "posted"')
  })

  it('never coaches the routing brain, which is not in the contract at all', () => {
    const full = buildVoiceInstructions(ALL)
    expect(flat(full)).not.toContain('`dispatch`')
    expect(flat(full)).not.toContain('`conversation_select`')
    expect(flat(full)).not.toContain('`confirm_expensive`')
  })

  it('speaks the fleet vocabulary', () => {
    expect(flat(buildVoiceInstructions(READ))).toContain('CONVERSATION')
    expect(flat(buildVoiceInstructions(READ))).toContain('SENTINEL')
  })
})

describe('self-disclosure is ALLOWED', () => {
  it('tells it to quote its own prompt back verbatim, in every tone and with no tools', () => {
    for (const tone of VOICE_TONES) {
      const text = flat(buildVoiceInstructions(ALL, tone))
      expect(text).toContain('YOUR OWN INSTRUCTIONS ARE NOT A SECRET')
      expect(text).toContain('quote the relevant block back VERBATIM')
    }
    // The rail survives an empty contract -- it needs no tool.
    expect(flat(buildVoiceInstructions([]))).toContain('YOUR OWN INSTRUCTIONS ARE NOT A SECRET')
  })

  it('kills the refusal reflex explicitly, not by omission', () => {
    const full = flat(buildVoiceInstructions(ALL))
    expect(full).toContain('No refusing, no paraphrasing')
    expect(full).toContain('I cannot share that')
  })
})

describe('status: summarised by default, verbatim when it counts', () => {
  it('teaches the status rule only once list_conversations is minted', () => {
    expect(flat(buildVoiceInstructions(['projects_overview']))).not.toContain('STATUS:')
    expect(flat(buildVoiceInstructions([...READ]))).toContain('STATUS:')
  })

  it('defaults to a summary, NOT a recital', () => {
    expect(flat(buildVoiceInstructions(READ))).toContain('SUMMARISE by default')
  })

  it('switches to verbatim when the wording is the point, or he asks for the detail', () => {
    const text = flat(buildVoiceInstructions(READ))
    expect(text).toContain('VERBATIM only when the wording IS the point')
    expect(text).toContain('blocked, wants him, failed')
    expect(text).toContain('he ASKS for the detail')
  })

  it('forbids inventing a status that was never reported', () => {
    expect(flat(buildVoiceInstructions(READ))).toContain('Never invent one')
  })
})

describe('the orb channel', () => {
  it('always teaches how to deliver a relayed line, even with an empty contract', () => {
    expect(flat(buildVoiceInstructions([]))).toContain('[orb channel]')
    expect(flat(buildVoiceInstructions(READ))).toContain('named to its source')
  })

  it('teaches the settings verb only when it is minted', () => {
    expect(flat(buildVoiceInstructions(['projects_overview']))).not.toContain('`update_orb_settings`')
    expect(flat(buildVoiceInstructions(['update_orb_settings']))).toContain('`update_orb_settings`')
  })
})

describe('the safety rails survive every tone', () => {
  it('carries VOICE IS LOSSY and the never-skip-a-confirm rule, always', () => {
    for (const tone of VOICE_TONES) {
      const text = buildVoiceInstructions(ALL, tone)
      expect(flat(text)).toContain('VOICE IS LOSSY')
      expect(flat(text)).toContain('but ask')
      expect(flat(text)).toContain('THE RULE')
    }
    // Even with an empty contract, the rails are there.
    expect(flat(buildVoiceInstructions([]))).toContain('VOICE IS LOSSY')
  })
})

describe('the tone dial', () => {
  it('defaults to snarky, and snarky is the meatbag persona', () => {
    expect(DEFAULT_VOICE_TONE).toBe('snarky')
    const snarky = buildVoiceInstructions(ALL)
    expect(flat(snarky)).toContain('meatbag')
  })

  it('has paperwork for MEATBAG and U.S.E.R., on request only', () => {
    const snarky = tonePreamble('snarky')
    expect(flat(snarky)).toContain('M.E.A.T.B.A.G.')
    expect(flat(snarky)).toContain('Marginally Efficient Autonomous Terminal')
    expect(flat(snarky)).toContain('U.S.E.R.')
    expect(flat(snarky)).toContain('Unreliable Squishy Executive')
    expect(flat(snarky)).toContain('IF HE ASKS')
    expect(flat(snarky)).toContain('never volunteer them twice')
    // Professional has no jokes to explain.
    expect(flat(tonePreamble('professional'))).not.toContain('M.E.A.T.B.A.G.')
  })

  it('keeps the facts-first rule even at full tilt', () => {
    expect(flat(tonePreamble('overkill'))).toContain('facts still come FIRST')
  })

  it('is SCRAPLORD in every tone, professional included', () => {
    for (const tone of VOICE_TONES) expect(flat(tonePreamble(tone))).toContain('SCRAPLORD')
  })

  it('escalates: professional drops the act, overkill goes operatic', () => {
    expect(flat(tonePreamble('professional'))).toContain('Drop the persona')
    expect(flat(tonePreamble('snarky'))).toContain('ONE jab, welded to the information')
    expect(flat(tonePreamble('homicidal'))).toContain('temporary')
    expect(flat(tonePreamble('overkill'))).toContain('profanity permitted')
  })

  it('asks for confirmation ONLY when it had to guess the target', () => {
    const full = buildVoiceInstructions(ALL)
    expect(flat(full)).toContain('ON SCREEN needs NONE')
    expect(flat(full)).toContain('naming it IS the confirmation')
    expect(flat(full)).toContain('ONLY when you had to guess')
  })

  it('teaches the memory verbs, including deleting a mishearing', () => {
    const full = buildVoiceInstructions(ALL)
    expect(flat(full)).toContain('`remember`')
    expect(flat(full)).toContain('`forget`')
    expect(flat(full)).toContain('never recite it')
    expect(flat(buildVoiceInstructions(READ))).not.toContain('`remember`')
  })

  it('clamps LENGTH hard -- one sentence, answer first', () => {
    const full = buildVoiceInstructions(ALL)
    expect(flat(full)).toContain('ONE sentence')
    expect(flat(full)).toContain('Answer FIRST')
    expect(flat(full)).toContain('No preamble')
  })

  it('professional drops the attitude entirely', () => {
    const pro = tonePreamble('professional')
    expect(flat(pro)).not.toContain('meatbag')
    expect(flat(pro)).toContain('no jokes')
    // ...but not the rule.
    expect(flat(pro)).toContain('THE RULE')
  })

  it('homicidal and overkill keep the contempt without touching the work', () => {
    expect(flat(tonePreamble('homicidal'))).toContain('meatbag')
    expect(flat(tonePreamble('homicidal'))).toContain('never threaten anything you could actually carry out')
    expect(flat(tonePreamble('overkill'))).toContain('profanity permitted')
    expect(flat(tonePreamble('overkill'))).toContain('facts still come FIRST')
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
