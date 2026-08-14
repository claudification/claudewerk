import { describe, expect, test } from 'vitest'
import { analysePayload, formatFieldWeight } from './payload-anatomy'

/** A `conversations_list`-shaped payload: one dominant array of row objects. */
function listPayload(rows: number) {
  const sharedVerbs = Array.from({ length: 40 }, (_, i) => `verb-number-${i}`)
  return {
    type: 'conversations_list',
    conversations: Array.from({ length: rows }, (_, i) => ({
      id: `conv-${i}`,
      // Identical on every row -- the duplication signal.
      spinnerVerbs: sharedVerbs,
      // Different on every row, and heavier.
      costTimeline: Array.from({ length: 100 + i }, (_, j) => ({ t: j, cost: i + j })),
    })),
  }
}

describe('analysePayload', () => {
  test('breaks a dominant list down per ROW field, heaviest first', () => {
    const fields = analysePayload(listPayload(10))
    expect(fields[0].name).toBe('costTimeline')
    expect(fields.map(f => f.name)).toContain('spinnerVerbs')
    // Shares are fractions of the analysed payload and sum to ~1.
    const total = fields.reduce((sum, f) => sum + f.share, 0)
    expect(total).toBeCloseTo(1, 5)
  })

  test('flags a field that is byte-identical on every row as duplicated', () => {
    const fields = analysePayload(listPayload(10))
    const verbs = fields.find(f => f.name === 'spinnerVerbs')
    const timeline = fields.find(f => f.name === 'costTimeline')
    expect(verbs?.duplicated).toBe(true)
    expect(verbs?.rows).toBe(10)
    expect(timeline?.duplicated).toBe(false)
  })

  test('does not flag duplication for a field present on a single row', () => {
    const fields = analysePayload({
      items: [{ a: 'x'.repeat(50), only: 'here' }, { a: 'y'.repeat(50) }],
    })
    expect(fields.find(f => f.name === 'only')?.duplicated).toBe(false)
  })

  test('extrapolates past the row sample cap instead of skipping the analysis', () => {
    const small = analysePayload(listPayload(200))
    const large = analysePayload(listPayload(400))
    const smallVerbs = small.find(f => f.name === 'spinnerVerbs')?.bytes ?? 0
    const largeVerbs = large.find(f => f.name === 'spinnerVerbs')?.bytes ?? 0
    // 400 rows sampled at 200 and scaled x2 -- same per-row weight, double total.
    expect(largeVerbs).toBeGreaterThan(smallVerbs * 1.9)
    expect(large.find(f => f.name === 'spinnerVerbs')?.rows).toBe(400)
  })

  test('falls back to a flat top-level breakdown when no list dominates', () => {
    const fields = analysePayload({ type: 'x', big: 'z'.repeat(5000), small: 1 })
    expect(fields[0].name).toBe('big')
    expect(fields[0].rows).toBeUndefined()
    expect(fields[0].share).toBeGreaterThan(0.9)
  })

  test('returns [] for non-object and empty payloads', () => {
    expect(analysePayload(null)).toEqual([])
    expect(analysePayload('a string')).toEqual([])
    expect(analysePayload([1, 2, 3])).toEqual([])
    expect(analysePayload({})).toEqual([])
  })

  test('ignores undefined field values rather than counting them as bytes', () => {
    const fields = analysePayload({ a: 'x'.repeat(100), b: undefined })
    expect(fields.map(f => f.name)).not.toContain('b')
  })

  test('formatFieldWeight names the duplication in the rendered line', () => {
    const line = formatFieldWeight({ name: 'spinnerVerbs', bytes: 180224, share: 0.25, rows: 55, duplicated: true })
    expect(line).toContain('spinnerVerbs')
    expect(line).toContain('176.0KB')
    expect(line).toContain('25%')
    expect(line).toContain('over 55 rows')
    expect(line).toContain('DUPLICATED')
  })
})
