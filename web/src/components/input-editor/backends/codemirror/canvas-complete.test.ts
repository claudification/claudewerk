import { describe, expect, it } from 'vitest'
import { scanCanvasTrigger } from './canvas-complete'

describe('scanCanvasTrigger', () => {
  it('matches !c: at doc start', () => {
    const r = scanCanvasTrigger('!c:arch', 7)
    expect(r).toEqual({ start: 0, query: 'arch' })
  })

  it('matches !c: after whitespace and reports the ! offset', () => {
    const text = 'draw me !c:flow'
    const r = scanCanvasTrigger(text, text.length)
    expect(r?.query).toBe('flow')
    expect(text.slice(r?.start)).toBe('!c:flow')
  })

  it('matches a bare !c: with an empty query', () => {
    expect(scanCanvasTrigger('!c:', 3)).toEqual({ start: 0, query: '' })
  })

  it('does not match mid-word or with whitespace in the query', () => {
    expect(scanCanvasTrigger('foo!c:bar', 9)).toBeNull() // not at start/after-space
    expect(scanCanvasTrigger('!c:foo bar', 10)).toBeNull() // space ends the trigger
  })

  it('does not match without the trigger', () => {
    expect(scanCanvasTrigger('hello world', 11)).toBeNull()
  })
})
