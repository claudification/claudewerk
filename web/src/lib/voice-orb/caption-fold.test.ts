import { describe, expect, it } from 'vitest'
import { foldCaption, type SpokenLine } from './caption-fold'

const agent = (text: string, partial = true) => ({ role: 'agent' as const, text, partial })
const user = (text: string) => ({ role: 'user' as const, text, partial: false })

/** Replay a stream of chunks the way the session pumps them. */
function play(chunks: Parameters<typeof foldCaption>[1][]): SpokenLine | null {
  return chunks.reduce<SpokenLine | null>((line, c) => foldCaption(line, c), null)
}

describe('foldCaption', () => {
  it('accumulates streaming deltas into one sentence (the one-word-at-a-time bug)', () => {
    const line = play([agent('Three '), agent('of your '), agent('conversations are flailing.')])
    expect(line).toEqual({ role: 'agent', text: 'Three of your conversations are flailing.', partial: true })
  })

  it('the final transcript REPLACES the accumulation -- never doubles it', () => {
    const line = play([agent('Three '), agent('of your'), agent('Three of your conversations.', false)])
    expect(line).toEqual({ role: 'agent', text: 'Three of your conversations.', partial: false })
  })

  it('a new turn starts a fresh line instead of continuing the last one', () => {
    const line = play([agent('First answer.', false), agent('Second '), agent('answer.')])
    expect(line?.text).toBe('Second answer.')
  })

  it('what it HEARD is tagged user, and never merges into what it said', () => {
    const line = play([agent('I was saying'), user('actually, stop')])
    expect(line).toEqual({ role: 'user', text: 'actually, stop', partial: false })
  })

  it('after a barge-in the next answer starts clean', () => {
    const line = play([agent('I was say'), user('stop'), agent('Fine. '), agent('What now?')])
    expect(line).toEqual({ role: 'agent', text: 'Fine. What now?', partial: true })
  })

  it('two user utterances in a row do not concatenate', () => {
    expect(play([user('one'), user('two')])?.text).toBe('two')
  })

  it('handles an empty delta without corrupting the line', () => {
    expect(play([agent('hello'), agent('')])?.text).toBe('hello')
  })
})
