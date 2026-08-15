import { describe, expect, it } from 'vitest'
import { deFluff } from './voice-defluff'

describe('deFluff', () => {
  it('drops a filler wrapped in commas without fusing the words', () => {
    expect(deFluff('and, uh, be configured with some authentication')).toBe(
      'And be configured with some authentication',
    )
  })

  // The commas around a filler are speech-to-text punctuating the HESITATION,
  // not a clause the speaker meant, so they leave with it. Keeping one back
  // reads worse on real dictation ("able to, webhook receivers").
  it('takes the bracketing commas with the filler', () => {
    expect(deFluff('able to, uh, webhook receivers')).toBe('Able to webhook receivers')
    expect(deFluff('can match, uh, a URL')).toBe('Can match a URL')
  })

  it('drops a leading filler and recapitalises what it exposed', () => {
    expect(deFluff('uh, when I post using the voice hotkey')).toBe('When I post using the voice hotkey')
  })

  it('handles a filler that ends a sentence', () => {
    expect(deFluff('Some webhooks require it, uh. Then we store it.')).toBe(
      'Some webhooks require it. Then we store it.',
    )
  })

  it('eats drawn-out variants', () => {
    expect(deFluff('so ummmm yeah')).toBe('So yeah')
    expect(deFluff('it is, hmmm, fine')).toBe('It is fine')
  })

  it('NEVER dedupes repeated words -- a stutter is how people talk', () => {
    expect(deFluff("So for now, I'm I'm gonna release this key")).toBe("So for now, I'm I'm gonna release this key")
    expect(deFluff('the CLI will, uh, pull, pull at the queue')).toBe('The CLI will pull, pull at the queue')
  })

  it('preserves paragraph breaks (a flux turn boundary is structure)', () => {
    expect(deFluff('first turn, uh, here\n\nsecond turn, um, there')).toBe('First turn here\n\nSecond turn there')
  })

  it('leaves discourse markers alone -- they carry meaning', () => {
    const s = 'Basically it is like a queue, you know, sort of'
    expect(deFluff(s)).toBe(s)
  })

  it('does not maul words that merely contain a filler', () => {
    expect(deFluff('the summer number is uhh done')).toBe('The summer number is done')
    expect(deFluff('Germany and Ermintrude')).toBe('Germany and Ermintrude')
  })

  it('is a no-op on clean typed text', () => {
    const s = 'Wrap it in a container so the receiver knows it came from voice.'
    expect(deFluff(s)).toBe(s)
  })

  // The recapitalisation exists only to repair what the strip broke. With no
  // filler present there is nothing to repair, so the user's own capitalisation
  // is left exactly as it was.
  it('does NOT recapitalise when it stripped nothing', () => {
    expect(deFluff('hello world')).toBe('hello world')
    expect(deFluff('iphone stays lowercase. so does this.')).toBe('iphone stays lowercase. so does this.')
  })

  it('handles empty and whitespace input', () => {
    expect(deFluff('')).toBe('')
    expect(deFluff('   ')).toBe('')
  })

  // The real thing, straight off the wire: Jonas dictating the agent-drop
  // webhook-receiver idea. If this ever regresses, it regresses on live data.
  it('cleans a real dictated paragraph', () => {
    const raw =
      'of it, you know, agent drop, also being able to, uh, webhook receivers, uh, ' +
      'basically create a webhook receiver that, one, can match, uh, a URL and, two, ' +
      'uh, possibly answer a initial authorization.'
    const out = deFluff(raw)
    expect(out).not.toMatch(/\buh\b/i)
    expect(out).toContain('you know') // discourse marker survives
    expect(out).toContain('basically') // ditto
    expect(out).not.toMatch(/,\s*,/) // no doubled commas
    expect(out).not.toMatch(/\s{2,}/) // no collapsed-out double spaces
    expect(out).toBe(
      'Of it, you know, agent drop, also being able to webhook receivers ' +
        'basically create a webhook receiver that, one, can match a URL and, two ' +
        'possibly answer a initial authorization.',
    )
  })
})
