import { describe, expect, it } from 'bun:test'
import { DRAW_INLINE_MAX, type DrawValue, isDrawValue, utf8Bytes } from './draw'

describe('isDrawValue', () => {
  it('accepts inline draw and draw-ref shapes', () => {
    const inline: DrawValue = { kind: 'draw', snapshot: '{}', bytes: 2 }
    const ref: DrawValue = { kind: 'draw-ref', url: 'https://x/file/abc.json', bytes: 99 }
    expect(isDrawValue(inline)).toBe(true)
    expect(isDrawValue(ref)).toBe(true)
  })

  it('rejects non-draw values', () => {
    expect(isDrawValue(null)).toBe(false)
    expect(isDrawValue('draw')).toBe(false)
    expect(isDrawValue({ kind: 'image' })).toBe(false)
    expect(isDrawValue({ snapshot: '{}' })).toBe(false)
  })
})

describe('utf8Bytes', () => {
  it('counts UTF-8 bytes, not code units', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('🎨')).toBe(4)
  })
})

describe('DRAW_INLINE_MAX spill threshold', () => {
  it('is the 256KB inline ceiling', () => {
    expect(DRAW_INLINE_MAX).toBe(256 * 1024)
  })

  it('classifies a snapshot as spill-worthy strictly above the ceiling', () => {
    const small = { kind: 'draw', snapshot: 'x', bytes: DRAW_INLINE_MAX } as DrawValue
    const big = { kind: 'draw', snapshot: 'x', bytes: DRAW_INLINE_MAX + 1 } as DrawValue
    const spills = (v: DrawValue) => v.kind === 'draw' && v.bytes > DRAW_INLINE_MAX
    expect(spills(small)).toBe(false)
    expect(spills(big)).toBe(true)
  })
})
