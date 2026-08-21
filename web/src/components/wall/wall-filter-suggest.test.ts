/**
 * @vitest-environment node
 */

/**
 * WHICH SIGIL IS THE CARET IN -- the edge cases, one line each.
 *
 * The dropdown itself is proved through the box (`wall-filter-box.test.tsx`);
 * what is here is the string maths under it, where every interesting case is a
 * caret position rather than something a render can show you.
 */

import { describe, expect, it } from 'vitest'
import {
  activeSuggestToken,
  applySuggestion,
  rankSuggestions,
  suggestKeyAction,
  suggestToken,
} from './wall-filter-suggest'

/** `raw` with `|` marking the caret -- the caret IS the input here, so writing
 *  it inline beats a second numeric argument nobody can read. */
function at(marked: string) {
  const caret = marked.indexOf('|')
  return activeSuggestToken(marked.replace('|', ''), caret)
}

describe('activeSuggestToken', () => {
  it('finds every sigil that scopes to a name', () => {
    expect(at('@rem|')?.sigil).toBe('@')
    expect(at('#wip|')?.sigil).toBe('#')
    expect(at('&stu|')?.sigil).toBe('&')
    expect(at(':opu|')?.sigil).toBe(':')
    expect(at('^eng|')?.sigil).toBe('^')
  })

  it('offers the whole list the moment the sigil is typed', () => {
    expect(at('@|')).toMatchObject({ sigil: '@', needle: '' })
  })

  it('says nothing for free text, a number sigil, or a quoted literal', () => {
    // Each of these has no value list to offer, so a dropdown would be noise.
    expect(at('ceiling|')).toBeNull()
    expect(at('$1|')).toBeNull()
    expect(at('%70|')).toBeNull()
    expect(at('~30m|')).toBeNull()
    expect(at('!!|')).toBeNull()
    expect(at('+over|')).toBeNull()
    expect(at('"@rem|"')).toBeNull()
    expect(at('-|')).toBeNull()
  })

  it('completes the token the caret is IN, not the last one typed', () => {
    expect(at('@rc #wi|p ~30m')).toMatchObject({ sigil: '#', needle: 'wi' })
  })

  it('matches on what is LEFT of the caret and replaces the whole token', () => {
    // Editing the middle of `#wippp`: the needle is `wi`, but accepting has to
    // take the trailing `ppp` with it or the box keeps a fragment.
    const token = at('#wi|ppp')
    expect(token).toMatchObject({ needle: 'wi', start: 0, end: 6 })
  })

  it('keeps the minus on a negated token', () => {
    expect(at('-@anv|')).toMatchObject({ sigil: '@', needle: 'anv', negated: true })
  })

  it('says nothing when the caret sits on or before the sigil', () => {
    expect(at('|@rem')).toBeNull()
    expect(at('@|rem')).toMatchObject({ needle: '' })
    expect(at('-|@rem')).toBeNull()
  })

  it('lowercases the needle, because the grammar does', () => {
    expect(at('@REM|')?.needle).toBe('rem')
  })
})

describe('rankSuggestions', () => {
  const values = ['remote-claude', 'anvil-md', 'gate-meet-demo', 'remote-control']

  it('keeps the caller order when nothing has been typed yet', () => {
    expect(rankSuggestions('', values)).toEqual(values)
  })

  it('drops what cannot match at all', () => {
    expect(rankSuggestions('zzz', values)).toEqual([])
  })

  it('is fuzzy, and puts the better match first', () => {
    expect(rankSuggestions('remote', values)[0]).toBe('remote-claude')
    expect(rankSuggestions('gmd', values)).toEqual(['gate-meet-demo'])
  })

  it('caps the list', () => {
    expect(rankSuggestions('', values, 2)).toHaveLength(2)
  })
})

describe('suggestKeyAction', () => {
  it('wraps at both ends rather than sticking', () => {
    expect(suggestKeyAction('ArrowDown', 2, 3)).toEqual({ move: 0 })
    expect(suggestKeyAction('ArrowUp', 0, 3)).toEqual({ move: 2 })
  })

  it('accepts on Tab and on Enter', () => {
    expect(suggestKeyAction('Tab', 0, 3)).toEqual({ accept: true })
    expect(suggestKeyAction('Enter', 0, 3)).toEqual({ accept: true })
  })

  it('lets every other key through untouched', () => {
    expect(suggestKeyAction('a', 0, 3)).toBeNull()
    expect(suggestKeyAction('Escape', 0, 3)).toBeNull()
    expect(suggestKeyAction('ArrowLeft', 0, 3)).toBeNull()
  })

  it('claims nothing at all when the list is empty', () => {
    // Otherwise Enter on a plain free-text query would be swallowed by a
    // dropdown that is not on screen.
    expect(suggestKeyAction('Enter', 0, 0)).toBeNull()
    expect(suggestKeyAction('ArrowDown', 0, 0)).toBeNull()
  })

  it('survives a stale index left over from a longer list', () => {
    expect(suggestKeyAction('ArrowDown', 9, 2)).toEqual({ move: 0 })
  })
})

describe('suggestToken', () => {
  it('hyphenates a name with a space, so it survives the tokenizer', () => {
    // `^client work` would split into `^client` plus a stray free-text `work`.
    expect(suggestToken('Client Work')).toBe('Client-Work')
    expect(suggestToken('  padded  name ')).toBe('padded-name')
  })
})

describe('applySuggestion', () => {
  const accept = (marked: string, value: string) => {
    const caret = marked.indexOf('|')
    const raw = marked.replace('|', '')
    const token = activeSuggestToken(raw, caret)
    if (!token) throw new Error(`no token at ${marked}`)
    const next = applySuggestion(raw, token, value)
    return `${next.raw.slice(0, next.caret)}|${next.raw.slice(next.caret)}`
  }

  it('replaces the token and parks the caret past a fresh space', () => {
    expect(accept('@rem|', 'remote-claude')).toBe('@remote-claude |')
  })

  it('keeps everything either side of the token', () => {
    // The caret lands PAST the separating space, ready for the next token.
    expect(accept('!! @rem| ~30m', 'remote-claude')).toBe('!! @remote-claude |~30m')
  })

  it('takes the tail of a half-edited token with it', () => {
    expect(accept('@rem|OTE-junk', 'remote-claude')).toBe('@remote-claude |')
  })

  it('keeps the minus', () => {
    expect(accept('-@anv|', 'anvil-md')).toBe('-@anvil-md |')
  })

  it('never doubles the separating space', () => {
    expect(accept('@rem| #wip', 'remote-claude')).toBe('@remote-claude |#wip')
  })

  it('hyphenates a spaced workspace name on the way in', () => {
    expect(accept('^cl|', 'Client Work')).toBe('^Client-Work |')
  })
})
