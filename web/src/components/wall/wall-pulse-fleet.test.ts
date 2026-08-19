/**
 * The fold behind P1: what survived the wall filter, regrouped into bands, and
 * -- the part worth a suite -- WHY each missing row is missing.
 */

import { describe, expect, it } from 'vitest'
import type { PulseFleet, PulseRow } from '@/components/pulse/use-pulse-fleet'
import type { PulseBand } from '@/lib/pulse/bands'
import { parseWallQuery } from '@/lib/wall/query'
import { wallPulseFleet } from './wall-pulse-fleet'

let seq = 0
function row(over: Partial<PulseRow> = {}): PulseRow {
  seq += 1
  return {
    id: `conv_${seq}`,
    conversation: { id: `conv_${seq}` } as PulseRow['conversation'],
    band: 'working',
    title: `thing ${seq}`,
    project: 'remote-claude',
    action: 'working',
    ageMs: 60_000,
    ...over,
  }
}

const ZERO: Record<PulseBand, number> = { blocked: 0, needs: 0, working: 0, done: 0, idle: 0, expired: 0 }

function base(flat: PulseRow[], expired: PulseRow[] = []): PulseFleet {
  return {
    groups: [],
    flat,
    totals: ZERO,
    expired,
    hidden: 0,
    managedHidden: 0,
    query: parseWallQuery(''),
    isEmpty: true,
  }
}

describe('wallPulseFleet', () => {
  it('groups the survivors in band order, dropping empty bands', () => {
    const rows = [row({ band: 'blocked' }), row({ band: 'working' }), row({ band: 'working' }), row({ band: 'idle' })]
    const fleet = wallPulseFleet(base(rows), rows, [], parseWallQuery(''))
    expect(fleet.groups.map(g => g.band)).toEqual(['blocked', 'working', 'idle'])
    expect(fleet.groups.map(g => g.rows.length)).toEqual([1, 2, 1])
  })

  it('keeps band order even when the rows arrive interleaved', () => {
    // `base.flat` is band-ordered, but a filter can only remove rows -- so the
    // partition must not depend on the incoming order being contiguous.
    const rows = [row({ band: 'idle' }), row({ band: 'blocked' }), row({ band: 'idle' })]
    const fleet = wallPulseFleet(base(rows), rows, [], parseWallQuery(''))
    expect(fleet.groups.map(g => g.band)).toEqual(['blocked', 'idle'])
  })

  it('counts what the QUERY removed as hidden', () => {
    const kept = row()
    const gone = row()
    const fleet = wallPulseFleet(base([kept, gone]), [kept], [], parseWallQuery('nothing'))
    expect(fleet.hidden).toBe(1)
    expect(fleet.managedHidden).toBe(0)
  })

  it('counts a machine-dispatched row hidden by the DEFAULT separately', () => {
    // The user typed nothing. Reporting this as "hidden by filter" would send
    // them hunting for a filter that is not there.
    const kept = row()
    const managed = row({ managed: true })
    const fleet = wallPulseFleet(base([kept, managed]), [kept], [], parseWallQuery(''))
    expect(fleet.managedHidden).toBe(1)
    expect(fleet.hidden).toBe(0)
  })

  it('stops calling machine runs hidden once +over is typed', () => {
    const managed = row({ managed: true })
    const fleet = wallPulseFleet(base([managed]), [managed], [], parseWallQuery('+over'))
    expect(fleet.managedHidden).toBe(0)
    expect(fleet.flat).toHaveLength(1)
  })

  it('totals the bands it kept, and the expired rows it was handed', () => {
    const rows = [row({ band: 'needs' }), row({ band: 'needs' }), row({ band: 'done' })]
    const fleet = wallPulseFleet(
      base(rows, [row({ band: 'expired' })]),
      rows,
      [row({ band: 'expired' })],
      parseWallQuery(''),
    )
    expect(fleet.totals.needs).toBe(2)
    expect(fleet.totals.done).toBe(1)
    expect(fleet.totals.expired).toBe(1)
    expect(fleet.totals.working).toBe(0)
  })

  it('carries the wall query through, so a row can highlight its own hit', () => {
    const query = parseWallQuery('ceiling')
    const fleet = wallPulseFleet(base([]), [], [], query)
    expect(fleet.query).toBe(query)
    expect(fleet.isEmpty).toBe(false)
  })
})
