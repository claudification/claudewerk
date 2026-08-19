/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { formatStoreReport, humanBytes, measureStore } from './store-sizeof'

describe('measureStore', () => {
  test('attributes bytes per top-level slice, sorted descending', () => {
    const state = {
      tiny: 1,
      big: { a: 'x'.repeat(10_000) },
      mid: ['y'.repeat(1000)],
    }
    const r = measureStore(state)
    expect(r.slices[0].key).toBe('big')
    expect(r.slices[0].bytes).toBeGreaterThan(r.slices[1].bytes)
    // bytes are descending across all slices
    for (let i = 1; i < r.slices.length; i++) {
      expect(r.slices[i - 1].bytes).toBeGreaterThanOrEqual(r.slices[i].bytes)
    }
  })

  test('classifies slice kind and count', () => {
    const state = {
      mapSlice: { c1: [1, 2], c2: [3] },
      arrSlice: [1, 2, 3, 4],
      valSlice: 42,
    }
    const r = measureStore(state)
    const byKey = Object.fromEntries(r.slices.map(s => [s.key, s]))
    expect(byKey.mapSlice).toMatchObject({ kind: 'map', count: 2 })
    expect(byKey.arrSlice).toMatchObject({ kind: 'array', count: 4 })
    expect(byKey.valSlice).toMatchObject({ kind: 'value', count: 1 })
  })

  test('per-conversation breakdown reports item count and largest single item', () => {
    const state = {
      transcripts: {
        convA: ['short', 'z'.repeat(5000)],
        convB: ['tiny'],
      },
    }
    const r = measureStore(state)
    const a = r.subs.find(s => s.slice === 'transcripts' && s.subKey === 'convA')
    expect(a).toBeDefined()
    expect(a?.count).toBe(2)
    // maxItemBytes reflects the single 5000-char string (~10KB), not the whole array
    expect(a?.maxItemBytes ?? 0).toBeGreaterThan(9000)
    // convA (one huge entry) outweighs convB
    expect(r.subs[0].subKey).toBe('convA')
  })

  test('skips function-valued slices (zustand actions)', () => {
    const state = { data: { x: 'hello' }, doThing: () => 1 }
    const r = measureStore(state)
    expect(r.slices.some(s => s.key === 'doThing')).toBe(false)
    expect(r.slices.some(s => s.key === 'data')).toBe(true)
  })

  test('does not infinite-loop on cyclic references', () => {
    const cyclic: Record<string, unknown> = { name: 'node' }
    cyclic.self = cyclic
    const state = { graph: cyclic }
    const r = measureStore(state)
    expect(r.total).toBeGreaterThan(0)
    expect(r.truncated).toBe(false)
  })

  test('total is the sum of slice bytes', () => {
    const state = { a: 'x'.repeat(100), b: [1, 2, 3] }
    const r = measureStore(state)
    const sum = r.slices.reduce((acc, s) => acc + s.bytes, 0)
    expect(r.total).toBe(sum)
  })
})

describe('humanBytes', () => {
  test('formats across unit boundaries', () => {
    expect(humanBytes(512)).toBe('512 B')
    expect(humanBytes(2048)).toBe('2.0 KB')
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(humanBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})

describe('formatStoreReport', () => {
  test('emits markdown with totals and both tables', () => {
    const state = { transcripts: { convA: ['z'.repeat(5000)] } }
    const md = formatStoreReport(measureStore(state), '2026-06-02T00:00:00.000Z')
    expect(md).toContain('# Zustand Store Heap Report')
    expect(md).toContain('generated: 2026-06-02T00:00:00.000Z')
    expect(md).toContain('## Top-level slices')
    expect(md).toContain('## Per-key breakdown')
    expect(md).toContain('transcripts')
  })
})
