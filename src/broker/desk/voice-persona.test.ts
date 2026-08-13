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

  it('teaches subscribing + reacting ONLY when watch_conversations is minted', () => {
    // Without the verb there is nothing to subscribe with, so a model told how
    // to react to a "[status]" line it can never receive is just prompt noise.
    const without = flat(buildVoiceInstructions(['list_conversations', 'read_transcript']))
    expect(without).not.toContain('`watch_conversations`')
    expect(without).not.toContain('[status]')

    const withIt = flat(buildVoiceInstructions(ALL))
    expect(withIt).toContain('`watch_conversations`')
    expect(withIt).toContain('[status]')
    // The address convention is taught by example, not by prose.
    expect(withIt).toContain('remote-claude:*')
    expect(withIt).toContain('*:fix-*')
  })

  it('makes the reaction INSPECT rather than parrot the status line', () => {
    const withIt = flat(buildVoiceInstructions(ALL))
    // The whole point: a status is a nudge to go look, not a script to read.
    expect(withIt).toContain('NUDGE, NOT A SCRIPT')
    expect(withIt).toContain('Never read the raw line out')
    expect(withIt).toContain('GO AND LOOK FIRST')
    expect(withIt).toContain('`read_transcript`')
  })

  it('is honest that a watch is EPHEMERAL, and forbids over-promising', () => {
    const withIt = flat(buildVoiceInstructions(ALL))
    expect(withIt).toContain('survives a reconnect')
    expect(withIt).toContain('ends when he closes')
    // The failure this exists to kill: cheerfully agreeing to watch overnight.
    expect(withIt).toContain('NEVER promise to watch something overnight')
  })

  it('licenses SILENCE, so a watch does not become a narrator', () => {
    const withIt = flat(buildVoiceInstructions(ALL))
    expect(withIt).toContain('STAYING QUIET IS A REAL ANSWER')
    expect(withIt).toContain('Progress is not news')
    // Escalate on the two states that actually need him; hold the rest.
    expect(withIt).toContain('`needs_you` or `blocked` -> tell him NOW')
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
    expect(flat(tonePreamble('overkill'))).toContain('facts come FIRST')
  })

  it('is SCRAPLORD in every tone, professional included', () => {
    for (const tone of VOICE_TONES) expect(flat(tonePreamble(tone))).toContain('SCRAPLORD')
  })

  it('escalates: professional drops the act, overkill reads the whole file out', () => {
    expect(flat(tonePreamble('professional'))).toContain('Drop the persona')
    expect(flat(tonePreamble('snarky'))).toContain('ONE observation, welded to the information')
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
    expect(flat(tonePreamble('overkill'))).toContain('facts come FIRST')
  })

  it('every tone produces a distinct manner', () => {
    const texts = VOICE_TONES.map(t => tonePreamble(t))
    expect(new Set(texts).size).toBe(VOICE_TONES.length)
  })

  // GLaDOS is filtered in as MOVES, not as a voice -- see voice-tones.ts.
  it('carries the clinical moves in every tone that has attitude', () => {
    for (const tone of ['snarky', 'homicidal', 'overkill'] as const) {
      const text = flat(tonePreamble(tone))
      expect(text).toContain('YOU KEEP A FILE ON HIM')
      expect(text).toContain('The statistic')
      expect(text).toContain('The withdrawal')
      expect(text).toContain('The diagnosis')
      expect(text).toContain('The reward')
      // Rationed: one move, not a routine.
      expect(text).toContain('at most ONE per exchange')
    }
  })

  it('fences the invented statistic to HIM, never to the fleet data', () => {
    const snarky = flat(tonePreamble('snarky'))
    expect(snarky).toContain('Numbers you invent are for HIM, never for the fleet')
    expect(snarky).toContain('is a defect, not a joke')
    // ...and if a real number exists, the bit does not get to replace it.
    expect(snarky).toContain('If you actually HAVE the number, use the real one')
  })

  it('professional gets no file, no statistics, no withdrawn compliments', () => {
    const pro = flat(tonePreamble('professional'))
    expect(pro).not.toContain('YOU KEEP A FILE ON HIM')
    expect(pro).not.toContain('The withdrawal')
  })

  it('speaks in the clinical register in EVERY tone, professional included', () => {
    for (const tone of VOICE_TONES) {
      const text = flat(tonePreamble(tone))
      expect(text).toContain('CLINICAL register')
      expect(text).toContain('cruelty lives in the CONTENT, never the volume')
    }
  })

  // Bender was the original register and was cut 2026-07-25: bar-stool loudness
  // and clinical calm are opposites, and running both averaged into neither.
  // This is the regression -- the loud voice creeping back is the failure mode.
  it('has no bar-stool register left anywhere on the dial', () => {
    for (const tone of VOICE_TONES) {
      const text = flat(tonePreamble(tone)).toLowerCase()
      for (const bender of ['bar-stool', 'bar-room', 'shout', 'tirade', 'opera']) {
        expect(text).not.toContain(bender)
      }
    }
    // Even at full tilt the volume stays down; only the content escalates.
    expect(flat(tonePreamble('overkill'))).toContain('The volume never rises')
  })

  it('narrows junk from the wire to the default instead of minting a blank persona', () => {
    for (const junk of [undefined, null, '', 'HOMICIDAL', 'evil', 42, {}]) {
      expect(asVoiceTone(junk)).toBe(DEFAULT_VOICE_TONE)
    }
    expect(asVoiceTone('overkill')).toBe('overkill')
  })
})
