/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test } from 'vitest'
import { setPerfEnabled } from './perf-metrics'
import { ANATOMY_THRESHOLD_BYTES, clearWireStats, getWireStats, recordWireIn, totalWireBytes } from './wire-stats'

function fatListPayload(rows: number) {
  return {
    type: 'conversations_list',
    conversations: Array.from({ length: rows }, (_, i) => ({
      id: `c${i}`,
      blob: 'x'.repeat(2000),
    })),
  }
}

describe('wire-stats', () => {
  beforeEach(() => {
    setPerfEnabled(false)
    setPerfEnabled(true)
    clearWireStats()
  })

  test('records nothing while the perf monitor is off', () => {
    setPerfEnabled(false)
    recordWireIn('conversations_list', 700_000, 2)
    expect(getWireStats()).toEqual([])
    expect(totalWireBytes()).toBe(0)
  })

  test('accumulates n, bytes, cpu and max per type', () => {
    recordWireIn('transcript_entries', 1000, 1)
    recordWireIn('transcript_entries', 3000, 2)
    recordWireIn('conversation_patch', 200, 0.5)
    const [first, second] = getWireStats()
    // Sorted by total bytes, heaviest first.
    expect(first.type).toBe('transcript_entries')
    expect(first.n).toBe(2)
    expect(first.bytes).toBe(4000)
    expect(first.maxBytes).toBe(3000)
    expect(first.cpuMs).toBeCloseTo(3, 5)
    expect(second.type).toBe('conversation_patch')
    expect(totalWireBytes()).toBe(4200)
  })

  test('dissects a payload over the threshold and names the heaviest field', () => {
    const payload = fatListPayload(40)
    recordWireIn('conversations_list', JSON.stringify(payload).length, 3, payload)
    const [stat] = getWireStats()
    expect(stat.fields?.[0].name).toBe('blob')
    expect(stat.fields?.[0].duplicated).toBe(true)
  })

  test('leaves small payloads undissected', () => {
    const payload = { type: 'ping', a: 1 }
    recordWireIn('ping', ANATOMY_THRESHOLD_BYTES - 1, 0.1, payload)
    expect(getWireStats()[0].fields).toBeUndefined()
  })

  test('re-dissects only on a new size high-water mark', () => {
    const small = fatListPayload(20)
    const big = fatListPayload(60)
    recordWireIn('conversations_list', JSON.stringify(small).length, 1, small)
    const afterSmall = getWireStats()[0].fields?.[0].rows
    // A SMALLER instance must not overwrite the breakdown of the worst case.
    recordWireIn('conversations_list', 100, 0.1, { type: 'conversations_list', conversations: [] })
    expect(getWireStats()[0].fields?.[0].rows).toBe(afterSmall)
    recordWireIn('conversations_list', JSON.stringify(big).length, 1, big)
    expect(getWireStats()[0].fields?.[0].rows).toBe(60)
  })

  test('returns a stable snapshot reference until the next message', () => {
    recordWireIn('a', 10, 1)
    const first = getWireStats()
    expect(getWireStats()).toBe(first)
    recordWireIn('a', 10, 1)
    expect(getWireStats()).not.toBe(first)
  })

  test('snapshot rows do not mutate behind an unchanged reference', () => {
    recordWireIn('a', 10, 1)
    const snap = getWireStats()
    recordWireIn('a', 10, 1)
    expect(snap[0].bytes).toBe(10)
  })

  test('turning the monitor off clears the accumulator', () => {
    recordWireIn('a', 10, 1)
    expect(totalWireBytes()).toBe(10)
    setPerfEnabled(false)
    expect(getWireStats()).toEqual([])
    expect(totalWireBytes()).toBe(0)
  })
})
