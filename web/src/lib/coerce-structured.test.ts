import { describe, expect, it } from 'vitest'
import { coerceStructured } from './coerce-structured'

describe('coerceStructured', () => {
  it('treats objects as data', () => {
    const r = coerceStructured({ a: 1 })
    expect(r.kind).toBe('data')
    expect(r.data).toEqual({ a: 1 })
    expect(r.fromJsonString).toBe(false)
  })

  it('treats arrays as data', () => {
    const r = coerceStructured([1, 2, 3])
    expect(r.kind).toBe('data')
    expect(r.data).toEqual([1, 2, 3])
  })

  it('parses JSON-object strings into data', () => {
    const r = coerceStructured('{"ok":true,"n":2}')
    expect(r.kind).toBe('data')
    expect(r.data).toEqual({ ok: true, n: 2 })
    expect(r.fromJsonString).toBe(true)
  })

  it('parses JSON-array strings into data', () => {
    const r = coerceStructured(' [1,2] ')
    expect(r.kind).toBe('data')
    expect(r.data).toEqual([1, 2])
    expect(r.fromJsonString).toBe(true)
  })

  it('keeps plain text as text', () => {
    const r = coerceStructured('hello world')
    expect(r.kind).toBe('text')
    expect(r.text).toBe('hello world')
    expect(r.fromJsonString).toBe(false)
  })

  it('keeps malformed JSON-looking strings as text', () => {
    const r = coerceStructured('{not json')
    expect(r.kind).toBe('text')
    expect(r.text).toBe('{not json')
  })

  it('keeps bare JSON scalars as text (not worth a tree)', () => {
    expect(coerceStructured('42').kind).toBe('text')
    expect(coerceStructured('"quoted"').kind).toBe('text')
  })

  it('renders primitives and nullish as text', () => {
    expect(coerceStructured(42)).toEqual({ kind: 'text', text: '42', fromJsonString: false })
    expect(coerceStructured(true)).toEqual({ kind: 'text', text: 'true', fromJsonString: false })
    expect(coerceStructured(null)).toEqual({ kind: 'text', text: 'null', fromJsonString: false })
    expect(coerceStructured(undefined)).toEqual({ kind: 'text', text: 'undefined', fromJsonString: false })
  })
})
