/**
 * Group sizing -- the reserved-height layer both renderers share.
 *
 * The property that matters for scroll-back is RELATIVE, not absolute: a group
 * that is obviously tall (many tool calls, lots of text) must reserve
 * obviously more than a one-line divider. The old plain-renderer behavior gave
 * both of them 200px, and the difference was paid as a shove in the reader's
 * face the moment the box rendered.
 */

import { describe, expect, it } from 'vitest'
import { estimateGroupSize, getConvSizeCache, trimConvSizeCache } from './group-sizing'
import type { DisplayGroup } from './grouping'

function assistantGroup(opts: { text?: string; tools?: number } = {}): DisplayGroup {
  const content: Array<{ type: string; text?: string }> = []
  if (opts.text) content.push({ type: 'text', text: opts.text })
  for (let i = 0; i < (opts.tools ?? 0); i++) content.push({ type: 'tool_use' })
  return {
    type: 'assistant',
    timestamp: '2026-07-25T00:00:00.000Z',
    entries: [{ message: { content } }],
  } as unknown as DisplayGroup
}

const FLAT = 200

describe('estimateGroupSize', () => {
  it('returns the measured height when one was recorded', () => {
    const sizes = new Map([['k', 1234]])
    expect(estimateGroupSize(assistantGroup({ text: 'x' }), sizes, 'k')).toBe(1234)
  })

  it('scales with tool calls and text -- the flat guess did not', () => {
    const small = estimateGroupSize(assistantGroup({ text: 'hi' }), new Map(), 'a')
    const big = estimateGroupSize(assistantGroup({ text: 'x'.repeat(4000), tools: 6 }), new Map(), 'b')
    expect(big).toBeGreaterThan(small * 4)
    // The exact case the flat 200px seed got wrong by an order of magnitude.
    expect(big).toBeGreaterThan(FLAT * 4)
    expect(small).toBeLessThan(FLAT)
  })

  it('reserves nearly nothing for one-line dividers', () => {
    const divider = { type: 'compacted', timestamp: '', entries: [] } as unknown as DisplayGroup
    expect(estimateGroupSize(divider, new Map(), 'd')).toBeLessThan(FLAT / 2)
  })

  it('never returns a negative or absurd height', () => {
    const huge = estimateGroupSize(assistantGroup({ text: 'x'.repeat(2_000_000), tools: 400 }), new Map(), 'h')
    expect(huge).toBeGreaterThan(0)
    expect(huge).toBeLessThanOrEqual(4000)
  })

  it('bypasses the cache for the scrollback spacer (computed, not measured)', () => {
    const spacer = {
      type: 'scrollback_spacer',
      spacerHeight: 900,
      timestamp: '',
      entries: [],
    } as unknown as DisplayGroup
    expect(estimateGroupSize(spacer, new Map([['s', 10]]), 's')).toBe(900)
  })
})

describe('conversation size cache', () => {
  it('hands the same map back for the same conversation and isolates others', () => {
    const a = getConvSizeCache('conv-a')
    a.set('k', 42)
    expect(getConvSizeCache('conv-a').get('k')).toBe(42)
    expect(getConvSizeCache('conv-b').get('k')).toBeUndefined()
  })

  it('returns a throwaway map for a missing conversation id', () => {
    const one = getConvSizeCache(undefined)
    one.set('k', 1)
    expect(getConvSizeCache(undefined).get('k')).toBeUndefined()
  })

  it('trims oldest-first past the inner cap', () => {
    const sizes = new Map<string, number>()
    for (let i = 0; i < 2100; i++) sizes.set(`k${i}`, i)
    trimConvSizeCache(sizes)
    expect(sizes.size).toBe(2000)
    expect(sizes.has('k0')).toBe(false)
    expect(sizes.has('k2099')).toBe(true)
  })
})
