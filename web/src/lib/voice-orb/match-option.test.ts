import { describe, expect, it } from 'vitest'
import type { VoiceOption } from './dialog-answerable'
import { cleanSpoken, matchSpokenOption } from './match-option'

const OPTIONS: VoiceOption[] = [
  { value: 'forward', label: 'Roll forward', description: 'redeploy on top' },
  { value: 'back', label: 'Roll back', description: 'revert to the last good build' },
  { value: 'wait', label: 'Wait for Jonas' },
]

const pick = (spoken: string) => matchSpokenOption(spoken, OPTIONS)

describe('stripping the way people actually talk', () => {
  it('drops leads, picks and politeness', () => {
    expect(cleanSpoken("let's go with the roll back, please")).toBe('roll back')
    expect(cleanSpoken('okay, take Wait for Jonas')).toBe('Wait for Jonas')
    expect(cleanSpoken('  Roll forward.  ')).toBe('Roll forward')
  })
})

describe('naming an option', () => {
  it('matches the label whatever the case or spacing', () => {
    expect(pick('roll back')).toMatchObject({ ok: true, option: { value: 'back' } })
    expect(pick('ROLLBACK')).toMatchObject({ ok: true, option: { value: 'back' } })
    expect(pick("I'll take roll forward")).toMatchObject({ ok: true, option: { value: 'forward' } })
  })

  it('matches the submitted value when he says it', () => {
    expect(pick('forward')).toMatchObject({ ok: true, option: { value: 'forward' } })
  })

  it('matches on a distinctive word from the description', () => {
    expect(pick('revert')).toMatchObject({ ok: true, option: { value: 'back' } })
  })
})

describe('counting to an option', () => {
  it('takes a purely positional phrase', () => {
    expect(pick('the second one')).toMatchObject({ ok: true, option: { value: 'back' } })
    expect(pick('option 3')).toMatchObject({ ok: true, option: { value: 'wait' } })
    expect(pick('number two')).toMatchObject({ ok: true, option: { value: 'back' } })
    expect(pick('the last one')).toMatchObject({ ok: true, option: { value: 'wait' } })
  })

  it('is out of range, so it refuses instead of clamping', () => {
    expect(pick('option 9')).toMatchObject({ ok: false })
  })

  it('lets a NAMED option beat the count when both could apply', () => {
    const numbered: VoiceOption[] = [
      { value: 'a', label: 'Plan A' },
      { value: 'two', label: 'Two' },
    ]
    // "two" is the label of the second option AND a position -- same answer here,
    // but the label is what decided it.
    expect(matchSpokenOption('two', numbered)).toMatchObject({ ok: true, option: { value: 'two' } })
    const flipped: VoiceOption[] = [
      { value: 'two', label: 'Two' },
      { value: 'b', label: 'Plan B' },
    ]
    expect(matchSpokenOption('two', flipped)).toMatchObject({ ok: true, option: { value: 'two' } })
  })
})

describe('refusing, rather than guessing', () => {
  it('submits nothing when the answer is not on the list', () => {
    const out = pick('cancel the whole thing')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain('not one of the options')
      expect(out.options).toHaveLength(3)
    }
  })

  it('submits nothing when two options match equally well', () => {
    const tied: VoiceOption[] = [
      { value: 'a', label: 'Deploy staging' },
      { value: 'b', label: 'Deploy prod' },
    ]
    const out = matchSpokenOption('deploy', tied)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error).toContain('could be either')
      expect(out.options.map(o => o.value)).toEqual(['a', 'b'])
    }
  })

  it('refuses an empty or non-string answer', () => {
    expect(pick('   ')).toMatchObject({ ok: false, error: 'no answer heard' })
    expect(matchSpokenOption(undefined as unknown as string, OPTIONS)).toMatchObject({ ok: false })
  })

  it('does not let a two-letter noise word match a long description', () => {
    expect(matchSpokenOption('no', OPTIONS)).toMatchObject({ ok: false })
  })
})
