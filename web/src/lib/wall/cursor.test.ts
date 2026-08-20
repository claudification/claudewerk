/**
 * The cursor's shape work, proved without React.
 *
 * Everything here is a rule that reads as obviously right and is wrong by one
 * position: which end of a positional ring is now, whether `ageMs >= offsetMs`
 * or `>` keeps the row that is exactly at the cursor, and what a pane is allowed
 * to show for a number nothing ever recorded a history of.
 */

import { NODE_STATS_INTERVAL_MS } from '@shared/node-stats'
import { describe, expect, it } from 'vitest'
import { existedAtCursor, formatCursorOffset, ringValueAtCursor } from './cursor'
import { type HostVitalsRow, hostVitalsAtCursor } from './host-vitals'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

describe('what the header prints', () => {
  it('says LIVE at zero and never a bare number anywhere else', () => {
    expect(formatCursorOffset(0)).toBe('LIVE')
    expect(formatCursorOffset(-5)).toBe('LIVE')
    expect(formatCursorOffset(9 * MINUTE)).toBe('T-9m')
    expect(formatCursorOffset(60 * MINUTE)).toBe('T-1h')
    expect(formatCursorOffset(102 * MINUTE)).toBe('T-1h42m')
    expect(formatCursorOffset(180 * MINUTE)).toBe('T-3h')
  })
})

describe('did this row exist at the cursor', () => {
  it('keeps a row that is exactly as old as the offset', () => {
    // The boundary is INCLUSIVE: a commit made at exactly T-42m was on the wall
    // at T-42m. Excluding it would make the row blink out for one minute of
    // scrubbing and back in for the next.
    expect(existedAtCursor(42 * MINUTE, 42 * MINUTE)).toBe(true)
    expect(existedAtCursor(42 * MINUTE - 1, 42 * MINUTE)).toBe(false)
    expect(existedAtCursor(43 * MINUTE, 42 * MINUTE)).toBe(true)
  })

  it('keeps a row with no clock at all, rather than blanking the pane', () => {
    expect(existedAtCursor(undefined, 42 * MINUTE)).toBe(true)
  })

  it('keeps everything at LIVE', () => {
    expect(existedAtCursor(0, 0)).toBe(true)
  })
})

describe('reading a positional ring at an offset', () => {
  // Oldest first, newest last -- the wire contract on `WallHostVitals`.
  const ring = [10, 20, 30, 40, 50]

  it('reads the NEWEST sample at LIVE', () => {
    expect(ringValueAtCursor(ring, 0, NODE_STATS_INTERVAL_MS)).toBe(50)
  })

  it('walks back one slot per cadence interval', () => {
    expect(ringValueAtCursor(ring, NODE_STATS_INTERVAL_MS, NODE_STATS_INTERVAL_MS)).toBe(40)
    expect(ringValueAtCursor(ring, 4 * NODE_STATS_INTERVAL_MS, NODE_STATS_INTERVAL_MS)).toBe(10)
  })

  it('refuses to answer past the end of the ring instead of pinning to the oldest', () => {
    // The failure this exists to stop: returning 10 for every offset from 20s to
    // three hours, which would draw a five-minute ring as a three-hour history.
    expect(ringValueAtCursor(ring, 5 * NODE_STATS_INTERVAL_MS, NODE_STATS_INTERVAL_MS)).toBeUndefined()
    expect(ringValueAtCursor(ring, 60 * MINUTE, NODE_STATS_INTERVAL_MS)).toBeUndefined()
    expect(ringValueAtCursor([], 0, NODE_STATS_INTERVAL_MS)).toBeUndefined()
  })
})

function host(over: Partial<HostVitalsRow> = {}): HostVitalsRow {
  return {
    nodeId: 'n-studio',
    alias: 'studio',
    at: NOW,
    cpuPct: 50,
    memPct: 61,
    diskPct: 99,
    load1: 4,
    cores: 12,
    conversations: 7,
    ageMs: 0,
    stale: false,
    // 60 slots at 5s = the five minutes the wire contract bounds the ring to.
    cpuHistory: Array.from({ length: 60 }, (_, i) => i),
    ...over,
  }
}

describe('S1 at a past offset', () => {
  it('hands back the ring value and NOTHING that has no history', () => {
    const [row] = hostVitalsAtCursor([host()], 60_000, NOW)

    // 60s back at a 5s cadence is 12 slots: index 59 - 12 = 47.
    expect(row?.cpuPct).toBe(47)
    // Ram, disk, load and the conversation count arrive as ONE current reading.
    // Nothing remembers what they were a minute ago, so the pane is handed the
    // same `undefined` it already renders as `--`.
    expect([row?.memPct, row?.diskPct, row?.load1, row?.conversations]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
  })

  it('cuts the sparkline at the cursor, so it ends on the number beside it', () => {
    const [row] = hostVitalsAtCursor([host()], 60_000, NOW)
    expect(row?.cpuHistory.at(-1)).toBe(row?.cpuPct)
    expect(row?.cpuHistory).toHaveLength(48)
  })

  it('DROPS a node whose ring does not reach that far back', () => {
    // The track is three hours; the ring is five minutes. Most of the track is
    // past the end of it, and the honest answer there is no row at all.
    expect(hostVitalsAtCursor([host()], 42 * MINUTE, NOW)).toEqual([])
  })

  it('reads a node that went quiet as stale AT THE CURSOR, not as live', () => {
    // Last sample 10 minutes ago; the cursor is one minute back, so at the
    // cursor this box had already been silent for nine.
    const quiet = host({ at: NOW - 10 * MINUTE, ageMs: 10 * MINUTE, stale: true })
    const [row] = hostVitalsAtCursor([quiet], MINUTE, NOW)

    expect(row?.stale).toBe(true)
    expect(row?.ageMs).toBe(9 * MINUTE)
    // Its newest sample IS the reading at the cursor -- there was no later one.
    expect(row?.cpuPct).toBe(59)
  })

  it('is a pass-through at LIVE', () => {
    const rows = [host()]
    expect(hostVitalsAtCursor(rows, 0, NOW)).toEqual(rows)
  })
})
