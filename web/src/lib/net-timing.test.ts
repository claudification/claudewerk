import { afterEach, describe, expect, test } from 'vitest'
import { fetchJsonTimed, parseServerTiming } from './net-timing'
import { categoryStats, getEntries, setPerfEnabled } from './perf-metrics'

const realFetch = globalThis.fetch

function stubFetch(res: Response | (() => never)) {
  globalThis.fetch = (async () => (typeof res === 'function' ? res() : res)) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  setPerfEnabled(false)
})

describe('parseServerTiming', () => {
  test('sums every dur= in the header', () => {
    expect(parseServerTiming('db;dur=12.5, render;dur=3')).toBeCloseTo(15.5, 5)
  })

  test('handles a single metric and surrounding whitespace', () => {
    expect(parseServerTiming('total; dur = 4')).toBeCloseTo(4, 5)
  })

  test('is undefined for a missing or dur-less header', () => {
    expect(parseServerTiming(null)).toBeUndefined()
    expect(parseServerTiming('cache;desc="hit"')).toBeUndefined()
  })
})

describe('fetchJsonTimed', () => {
  test('returns parsed JSON and records a net sample when the monitor is on', async () => {
    setPerfEnabled(true)
    stubFetch(new Response(JSON.stringify({ ok: 1 }), { headers: { 'server-timing': 'db;dur=6.4' } }))
    const data = await fetchJsonTimed<{ ok: number }>('transcript.cold', '/x')
    expect(data).toEqual({ ok: 1 })
    const sample = getEntries().find(e => e.category === 'net')
    expect(sample?.label).toBe('transcript.cold')
    expect(sample?.detail).toContain('srv=6.4ms')
    expect(sample?.detail).toContain('KB')
  })

  test('omits srv= when the response carries no Server-Timing', async () => {
    setPerfEnabled(true)
    stubFetch(new Response(JSON.stringify({ ok: 1 })))
    await fetchJsonTimed('commits.list', '/x')
    expect(getEntries().find(e => e.category === 'net')?.detail).not.toContain('srv=')
  })

  test('returns null on a non-OK response without recording a success sample', async () => {
    setPerfEnabled(true)
    stubFetch(new Response('nope', { status: 500 }))
    expect(await fetchJsonTimed('transcript.cold', '/x')).toBeNull()
    expect(categoryStats('net').count).toBe(0)
  })

  test('returns null and records a failure sample when fetch throws', async () => {
    setPerfEnabled(true)
    stubFetch(() => {
      throw new Error('network down')
    })
    expect(await fetchJsonTimed('transcript.cold', '/x')).toBeNull()
    expect(getEntries().find(e => e.category === 'net')?.label).toBe('transcript.cold.failed')
  })

  test('returns null on a malformed body', async () => {
    setPerfEnabled(true)
    stubFetch(new Response('{not json'))
    expect(await fetchJsonTimed('transcript.cold', '/x')).toBeNull()
  })

  test('still returns data, and records nothing, while the monitor is off', async () => {
    setPerfEnabled(false)
    stubFetch(new Response(JSON.stringify({ ok: 2 })))
    expect(await fetchJsonTimed<{ ok: number }>('transcript.cold', '/x')).toEqual({ ok: 2 })
    expect(getEntries().length).toBe(0)
  })
})
