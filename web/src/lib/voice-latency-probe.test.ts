/**
 * The report is meant to be PASTED -- into an issue, a chat, a commit message --
 * so its alignment and its unreachable case are the whole product. A screenshot
 * cannot be grepped or diffed; this can.
 */

import { describe, expect, it } from 'vitest'
import { formatLatencyReport, type LatencySample } from './voice-latency-probe'

const META = { transport: 'direct', model: 'nova-3', takenAt: '2026-08-14T00:30:00Z' }

const sample = (label: string, samples: number[]): LatencySample => {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    label,
    note: 'irrelevant to the report',
    samples,
    min: sorted[0] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  }
}

describe('formatLatencyReport', () => {
  it('fences the block so it survives a paste into markdown', () => {
    const out = formatLatencyReport([sample('Edge', [10, 20, 30])], META)
    expect(out.startsWith('```\n')).toBe(true)
    expect(out.endsWith('\n```')).toBe(true)
  })

  it('carries the context that makes the numbers mean anything later', () => {
    const out = formatLatencyReport([sample('Edge', [10])], META)
    // Without WHEN and WHICH TRANSPORT, a pasted table is unfalsifiable.
    expect(out).toContain('2026-08-14T00:30:00Z')
    expect(out).toContain('direct / nova-3')
  })

  it('aligns columns so a wide label cannot skew the table', () => {
    const out = formatLatencyReport(
      [sample('X', [10, 10, 10]), sample('A very much longer target name', [20, 20, 20])],
      META,
    )
    const rows = out.split('\n').filter(l => l.includes('ms'))
    const medianColumns = rows.map(l => l.indexOf('ms'))
    expect(new Set(medianColumns).size).toBe(1)
  })

  it('says unreachable rather than printing a fake 0ms', () => {
    const out = formatLatencyReport([sample('Dead', [])], META)
    expect(out).toContain('unreachable')
    // A zero would read as "instant", which is the opposite of the truth.
    expect(out).not.toContain('0ms')
  })

  it('reports the sample count, so a partial run cannot pass as a full one', () => {
    const out = formatLatencyReport([sample('Edge', [10, 20, 30])], META)
    const row = out.split('\n').find(l => l.startsWith('Edge')) as string
    expect(row.trim().endsWith('3')).toBe(true)
  })
})
