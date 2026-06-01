import { describe, expect, it } from 'vitest'
import {
  buildConversationRef,
  matchLeadingConversationRef,
  parseConversationRefs,
  referencedConversationIds,
} from './conversation-refs'

describe('buildConversationRef', () => {
  it('wraps id + label in the canonical token', () => {
    expect(buildConversationRef('conv_abc123', 'arr:viral-raccoon')).toBe(
      '<conversation id="conv_abc123">arr:viral-raccoon</conversation>',
    )
  })

  it('round-trips through parseConversationRefs', () => {
    const token = buildConversationRef('conv_xyz', 'proj:slug')
    const [ref] = parseConversationRefs(token)
    expect(ref.id).toBe('conv_xyz')
    expect(ref.label).toBe('proj:slug')
    expect(token.slice(ref.start, ref.end)).toBe(token)
  })
})

describe('parseConversationRefs', () => {
  it('returns [] for plain text', () => {
    expect(parseConversationRefs('just a normal message, no refs here')).toEqual([])
  })

  it('extracts a ref embedded mid-sentence with correct offsets', () => {
    const text = `hey ${buildConversationRef('conv_1', 'a:b')} please look`
    const refs = parseConversationRefs(text)
    expect(refs).toHaveLength(1)
    expect(refs[0].id).toBe('conv_1')
    expect(refs[0].label).toBe('a:b')
    expect(text.slice(refs[0].start, refs[0].end)).toBe('<conversation id="conv_1">a:b</conversation>')
  })

  it('extracts multiple refs in document order', () => {
    const text = `${buildConversationRef('conv_1', 'p:one')} and ${buildConversationRef('conv_2', 'p:two')}`
    const refs = parseConversationRefs(text)
    expect(refs.map(r => r.id)).toEqual(['conv_1', 'conv_2'])
  })

  it('ignores a malformed token (no close tag)', () => {
    expect(parseConversationRefs('<conversation id="conv_1">a:b')).toEqual([])
  })

  it('does not let a label swallow following content (label forbids "<")', () => {
    const text = '<conversation id="conv_1">a:b</conversation> text <conversation id="conv_2">c:d</conversation>'
    expect(parseConversationRefs(text).map(r => r.id)).toEqual(['conv_1', 'conv_2'])
  })

  it('is re-runnable (global regex lastIndex is reset each call)', () => {
    const text = buildConversationRef('conv_1', 'p:one')
    expect(parseConversationRefs(text)).toHaveLength(1)
    expect(parseConversationRefs(text)).toHaveLength(1)
  })
})

describe('referencedConversationIds', () => {
  it('dedupes repeated references, preserving first-seen order', () => {
    const text = [
      buildConversationRef('conv_2', 'p:two'),
      buildConversationRef('conv_1', 'p:one'),
      buildConversationRef('conv_2', 'p:two'),
    ].join(' ')
    expect(referencedConversationIds(text)).toEqual(['conv_2', 'conv_1'])
  })
})

describe('matchLeadingConversationRef', () => {
  it('matches a ref anchored at the start of src', () => {
    const hit = matchLeadingConversationRef('<conversation id="conv_9">x:y</conversation> trailing')
    expect(hit).toEqual({ raw: '<conversation id="conv_9">x:y</conversation>', id: 'conv_9', label: 'x:y' })
  })

  it('returns null when the ref is not at the start', () => {
    expect(matchLeadingConversationRef('prefix <conversation id="conv_9">x:y</conversation>')).toBeNull()
  })
})
