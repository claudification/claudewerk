import { describe, expect, test } from 'bun:test'
import { applyInputSourceHint, stripInputSourceHint, VOICE_HINT_ATTR } from './voice-hint'

describe('applyInputSourceHint', () => {
  test('leaves typed input completely untouched', () => {
    expect(applyInputSourceHint('just typing')).toBe('just typing')
    expect(applyInputSourceHint('just typing', undefined)).toBe('just typing')
  })

  test('prepends the hint for a dictated prompt', () => {
    const out = applyInputSourceHint('build the thing', 'voice')
    expect(out).toContain(VOICE_HINT_ATTR)
    expect(out.endsWith('build the thing')).toBe(true)
    expect(out.indexOf('build the thing')).toBeGreaterThan(0)
  })
})

describe('stripInputSourceHint', () => {
  test('round-trips: what the host prepends, the panel takes back off', () => {
    const original = 'wrap it in a container so the receiver knows'
    expect(stripInputSourceHint(applyInputSourceHint(original, 'voice'))).toEqual({
      text: original,
      source: 'voice',
    })
  })

  test('round-trips a multi-paragraph dictation without eating the breaks', () => {
    const original = 'first paragraph here\n\nsecond paragraph here'
    const { text, source } = stripInputSourceHint(applyInputSourceHint(original, 'voice'))
    expect(text).toBe(original)
    expect(source).toBe('voice')
  })

  test('reports no source for plain text', () => {
    expect(stripInputSourceHint('hello')).toEqual({ text: 'hello' })
  })

  test('leaves an UNRELATED system-reminder alone', () => {
    const s = '<system-reminder>something else entirely</system-reminder>\n\nhi'
    expect(stripInputSourceHint(s)).toEqual({ text: s })
  })

  // The marker is an attribute on the opening tag, not a phrase in the prose,
  // precisely so quoting the hint back cannot forge provenance.
  test('does not treat a QUOTED hint mid-message as dictation', () => {
    const pasted = `here is the bug, the agent sent me this:\n\n${applyInputSourceHint('x', 'voice')}`
    expect(stripInputSourceHint(pasted)).toEqual({ text: pasted })
  })

  test('is idempotent -- stripping twice changes nothing', () => {
    const once = stripInputSourceHint(applyInputSourceHint('hello', 'voice'))
    expect(stripInputSourceHint(once.text)).toEqual({ text: 'hello' })
  })
})
