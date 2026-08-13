/**
 * The whole point of the phase breakdown is that a MISSING measurement never
 * reads as a FAST one. Resource timing zeroes fields it cannot provide, so a
 * naive `responseStart - requestStart` reports 0ms for a request that actually
 * took seconds -- which is exactly how the old single-`duration` log let a
 * service-worker queue hide for so long.
 */

import { describe, expect, test } from 'vitest'
import { compressionRatio, formatPhases, formatSummary, phasesOf, summarize } from './resource-timing'

function entry(over: Partial<PerformanceResourceTiming>): PerformanceResourceTiming {
  return {
    name: 'https://host/assets/app-abc123.js',
    startTime: 0,
    duration: 0,
    workerStart: 0,
    fetchStart: 0,
    domainLookupStart: 0,
    domainLookupEnd: 0,
    connectStart: 0,
    connectEnd: 0,
    requestStart: 0,
    responseStart: 0,
    responseEnd: 0,
    transferSize: 0,
    encodedBodySize: 0,
    decodedBodySize: 0,
    nextHopProtocol: '',
    ...over,
  } as PerformanceResourceTiming
}

describe('phasesOf', () => {
  test('splits a plain network fetch into connect / ttfb / download', () => {
    const p = phasesOf(
      entry({
        startTime: 100,
        duration: 300,
        fetchStart: 100,
        domainLookupStart: 100,
        connectEnd: 150,
        requestStart: 150,
        responseStart: 350,
        responseEnd: 400,
        transferSize: 1000,
        decodedBodySize: 1000,
        nextHopProtocol: 'h2',
      }),
    )

    expect(p.connect).toBe(50)
    expect(p.wait).toBe(200)
    expect(p.download).toBe(50)
    expect(p.stall).toBe(0)
    expect(p.servedBy).toBe('network')
  })

  test('attributes service-worker dwell time instead of hiding it in the total', () => {
    // The request sat in the worker from 10 to 3700, then the network was quick.
    const p = phasesOf(
      entry({
        startTime: 0,
        duration: 3750,
        workerStart: 10,
        fetchStart: 3700,
        domainLookupStart: 3700,
        connectEnd: 3700,
        requestStart: 3700,
        responseStart: 3730,
        responseEnd: 3750,
        transferSize: 2000,
        decodedBodySize: 2000,
      }),
    )

    expect(p.sw).toBe(3690)
    expect(p.download).toBe(20)
    expect(p.servedBy).toBe('service-worker')
    // The 3.7s is now attributed, not left floating in an unexplained total.
    expect(p.stall).toBeLessThan(50)
  })

  test('unavailable timings stay null rather than collapsing to a fast zero', () => {
    const p = phasesOf(entry({ startTime: 0, duration: 3750, decodedBodySize: 500 }))

    expect(p.wait).toBeNull()
    expect(p.download).toBeNull()
    expect(p.connect).toBeNull()
    // Nothing could be attributed, so the whole duration shows up as stall.
    expect(p.stall).toBe(3750)
  })

  test('a reused connection reports no connect phase', () => {
    const p = phasesOf(
      entry({ duration: 60, fetchStart: 0, requestStart: 10, responseStart: 50, responseEnd: 60, transferSize: 10 }),
    )
    expect(p.connect).toBeNull()
  })
})

describe('compression reporting', () => {
  test('flags a response that came down uncompressed', () => {
    const p = phasesOf(entry({ duration: 10, transferSize: 1000, decodedBodySize: 1000 }))
    expect(compressionRatio(p)).toBe(1)
    expect(formatPhases(p)).toContain('UNCOMPRESSED')
  })

  test('reports the ratio when the server did compress', () => {
    const p = phasesOf(entry({ duration: 10, transferSize: 1000, decodedBodySize: 3500 }))
    expect(formatPhases(p)).toContain('gz=3.5x')
  })
})

describe('summarize', () => {
  test('counts uncompressed and service-worker-served assets', () => {
    const rows = [
      phasesOf(entry({ duration: 10, transferSize: 1000, decodedBodySize: 1000 })),
      phasesOf(entry({ duration: 10, transferSize: 1000, decodedBodySize: 4000 })),
      phasesOf(entry({ duration: 3700, workerStart: 1, fetchStart: 3600, transferSize: 500, decodedBodySize: 500 })),
    ]
    const s = summarize(rows, 4000)

    expect(s.count).toBe(3)
    expect(s.uncompressed).toBe(2)
    expect(s.viaServiceWorker).toBe(1)
    expect(formatSummary(s)).toContain('uncompressed=2/3')
  })
})
