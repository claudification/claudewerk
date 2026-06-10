import { describe, expect, it } from 'vitest'
import { scanColonTrigger } from './autocomplete'

// scanColonTrigger decides whether a `:` opens the conversation-mention popup.
// `pos` is the caret offset; the scanner walks back from pos-1 to the `:`.
function scan(text: string) {
  return scanColonTrigger(text, text.length)
}

describe('scanColonTrigger', () => {
  it('fires on a bare colon at doc start', () => {
    expect(scan(':')).toEqual({ start: 0, query: '' })
  })

  it('fires on a colon-led slug query', () => {
    expect(scan(':broker')).toEqual({ start: 0, query: 'broker' })
    expect(scan('hey :perf')).toEqual({ start: 4, query: 'perf' })
  })

  it('stays inert mid-word (prose like note:foo)', () => {
    expect(scan('note:foo')).toBeNull()
  })

  it('stays inert for double colon', () => {
    expect(scan('::')).toBeNull()
  })

  describe('smiley exceptions', () => {
    it('does not complete on punctuation emoticons', () => {
      for (const s of [':)', ':(', ':/', ':|', ':*', ':>', ':<', ':]', ':-)', ":'("]) {
        expect(scan(s), s).toBeNull()
      }
    })

    it('does not complete on alphanumeric-mouth smileys', () => {
      for (const s of [':D', ':P', ':p', ':O', ':o', ':3', ':x', ':X']) {
        expect(scan(s), s).toBeNull()
      }
    })

    it('does not complete on repeated-mouth smileys (:DD, :DDD, :ppp)', () => {
      for (const s of [':DD', ':DDD', ':ppp', ':ooo', ':XX']) {
        expect(scan(s), s).toBeNull()
      }
    })

    it('does not complete on a smiley followed by a space (:D )', () => {
      // caret after the trailing space — the space gate already kills it
      expect(scan(':D ')).toBeNull()
    })

    it('resumes completing once the query is a real mention (two distinct chars)', () => {
      expect(scan(':Da')).toEqual({ start: 0, query: 'Da' })
      expect(scan(':perf')).toEqual({ start: 0, query: 'perf' })
      expect(scan(':o-ola')).toEqual({ start: 0, query: 'o-ola' })
    })

    it('keeps lowercase d as a mention starter (:daemon)', () => {
      expect(scan(':d')).toEqual({ start: 0, query: 'd' })
      expect(scan(':daemon')).toEqual({ start: 0, query: 'daemon' })
    })
  })
})
