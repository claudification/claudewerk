import { describe, expect, it } from 'bun:test'
import { matchLeadingCallout } from './sotu-callout'

describe('matchLeadingCallout', () => {
  it('parses a basic typed callout', () => {
    const r = matchLeadingCallout('<callout type="insight">x is dead code</callout>')
    expect(r).not.toBeNull()
    expect(r?.type).toBe('insight')
    expect(r?.payload).toBe('x is dead code')
    expect(r?.path).toBeUndefined()
    expect(r?.raw).toBe('<callout type="insight">x is dead code</callout>')
  })

  it('parses a lock callout with a path attribute (claim target)', () => {
    const r = matchLeadingCallout('<callout type="lock" path="src/broker/permissions.ts">refactoring, ~1h</callout>')
    expect(r?.type).toBe('lock')
    expect(r?.path).toBe('src/broker/permissions.ts')
    expect(r?.payload).toBe('refactoring, ~1h')
  })

  it('is attribute-order independent', () => {
    const r = matchLeadingCallout('<callout path="a/b.ts" type="lock">claim</callout>')
    expect(r?.type).toBe('lock')
    expect(r?.path).toBe('a/b.ts')
  })

  it('accepts single-quoted attribute values', () => {
    const r = matchLeadingCallout("<callout type='blocked'>waiting on daemon fix</callout>")
    expect(r?.type).toBe('blocked')
    expect(r?.payload).toBe('waiting on daemon fix')
  })

  it('parses each valid type', () => {
    for (const t of ['insight', 'lock', 'blocked', 'focus', 'dead-end']) {
      const r = matchLeadingCallout(`<callout type="${t}">body</callout>`)
      expect(r?.type).toBe(t as never)
    }
  })

  it('returns null for an unknown type (under-emission is harmless)', () => {
    expect(matchLeadingCallout('<callout type="bogus">x</callout>')).toBeNull()
  })

  it('returns null when type is missing', () => {
    expect(matchLeadingCallout('<callout path="x">x</callout>')).toBeNull()
  })

  it('returns null when src does not START with a callout', () => {
    expect(matchLeadingCallout('prose then <callout type="insight">x</callout>')).toBeNull()
  })

  it('returns null for an unclosed tag (waits for more input)', () => {
    expect(matchLeadingCallout('<callout type="insight">x is dead')).toBeNull()
    expect(matchLeadingCallout('<callout type="insight"')).toBeNull()
  })

  it('matches only the FIRST callout, stopping at the first close tag', () => {
    const r = matchLeadingCallout('<callout type="insight">first</callout><callout type="lock">second</callout>')
    expect(r?.payload).toBe('first')
    expect(r?.raw).toBe('<callout type="insight">first</callout>')
  })

  it('preserves an empty body', () => {
    const r = matchLeadingCallout('<callout type="focus"></callout>')
    expect(r?.payload).toBe('')
  })

  it('tolerates whitespace before the closing bracket of the open tag', () => {
    const r = matchLeadingCallout('<callout type="insight" >body</callout>')
    expect(r?.type).toBe('insight')
    expect(r?.payload).toBe('body')
  })
})
