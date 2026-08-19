/**
 * A7's arithmetic: the bucket mapping, stall detection, and the lease alarm.
 *
 * These are the three the card names, and all three are pure -- which is the
 * whole reason they live in `run-model.ts` rather than inside the row. A stall
 * that can only be tested by rendering a component and mocking a clock is a
 * stall nobody re-tests after the first regression.
 */

import type { EpicLease } from '@shared/epic-lease'
import type { EpicLogEntry } from '@shared/epic-run-types'
import type { NightshiftTaskMeta } from '@shared/nightshift-types'
import type { EpicActivityEntry, EpicBeatRecord, EpicInspectResult } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import {
  batonTail,
  beatTicks,
  idleSentence,
  LEASE_STALE_MS,
  leaseState,
  NO_BUCKETS,
  nightshiftCounts,
  runBuckets,
  runStall,
} from './run-model'

const NOW = Date.parse('2026-08-19T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function entry(over: Partial<EpicActivityEntry> = {}): EpicActivityEntry {
  return {
    epicId: 'epic-the-wall',
    project: 'claude:///Users/j/remote-claude',
    status: 'armed',
    gen: 3,
    maxGens: 40,
    inFlight: 2,
    overseerAlive: true,
    armed: true,
    lastBeatAt: iso(20_000),
    stale: false,
    ...over,
  }
}

function card(id: string) {
  return { id, title: id, status: 'open' }
}

function inspect(over: Partial<EpicInspectResult> = {}): EpicInspectResult {
  return {
    epicId: 'epic-the-wall',
    project: 'claude:///Users/j/remote-claude',
    run: null,
    lease: null,
    plan: {
      children: 12,
      dispatch: [card('a')],
      verify: [card('b'), card('c')],
      questions: [],
      heldBack: [card('d'), card('e'), card('f')],
      waitingOnDeps: [card('g')],
      complete: false,
    },
    live: {
      armed: true,
      inFlight: ['conv-1', 'conv-2', 'conv-3', 'conv-4'],
      settled: [],
      unacknowledged: [],
      overseerAlive: true,
      maxGenSeen: 3,
      conversations: [],
    },
    beats: [],
    baton: [],
    ...over,
  }
}

describe('the DAG buckets', () => {
  it('maps every lane the inspect view computes, one for one', () => {
    // The pane must AGREE with `action=inspect`, so every number here is a
    // `.length` off a lane the broker already decided -- never a re-derivation.
    expect(runBuckets(inspect())).toEqual({
      ready: 1,
      inFlight: 4,
      verify: 2,
      held: 3,
      deps: 1,
      parked: 0,
    })
  })

  it('takes IN FLIGHT from the registry, not from the plan', () => {
    // The plan says what SHOULD happen; the registry says what IS happening.
    // Collapsing them would make a run with four live seats and nothing
    // dispatchable read as idle.
    const buckets = runBuckets(inspect({ plan: { ...inspect().plan!, dispatch: [] } }))
    expect(buckets.ready).toBe(0)
    expect(buckets.inFlight).toBe(4)
  })

  it('is all zeroes before the first inspect lands', () => {
    expect(runBuckets(null)).toEqual(NO_BUCKETS)
  })

  it('survives an epic that is not on the board at all', () => {
    expect(runBuckets(inspect({ plan: null }))).toEqual({ ...NO_BUCKETS, inFlight: 4 })
  })
})

describe('why nothing moved', () => {
  const idle = { ...inspect().plan!, dispatch: [], idleReason: 'every card waits on a dep' }

  it('prints the broker sentence when the run is armed and nothing is ready', () => {
    expect(idleSentence(entry(), inspect({ plan: idle }))).toBe('every card waits on a dep')
  })

  it('stays quiet on a PAUSED run -- paused is not news', () => {
    expect(idleSentence(entry({ status: 'paused' }), inspect({ plan: idle }))).toBeNull()
  })

  it('stays quiet when something IS dispatchable', () => {
    expect(idleSentence(entry(), inspect({ plan: { ...idle, dispatch: [card('a')] } }))).toBeNull()
  })
})

describe('stall detection', () => {
  it('trusts the broker `stale` flag so every surface agrees', () => {
    expect(runStall(entry({ stale: true, lastBeatAt: iso(240_000) }), NOW)).toEqual({
      stalled: true,
      sinceMs: 240_000,
    })
  })

  it('leaves a healthy run alone, with the beat age', () => {
    expect(runStall(entry(), NOW)).toEqual({ stalled: false, sinceMs: 20_000 })
  })

  it('STALLS a live run that has never beaten -- the case the broker flag cannot see', () => {
    // `epic-active.ts` computes stale as `lastBeatAt !== null && ...`, so an
    // armed epic the sweep never picked up reports stale:false forever. That is
    // the 2026-08-18 shape: looks fine, is not running.
    expect(runStall(entry({ lastBeatAt: null }), NOW)).toEqual({ stalled: true, sinceMs: null })
  })

  it('never calls a paused run stalled -- a paused run is SUPPOSED to be quiet', () => {
    expect(runStall(entry({ status: 'paused', stale: true, lastBeatAt: null }), NOW).stalled).toBe(false)
  })

  it('treats an unparseable beat stamp as never beaten rather than as now', () => {
    expect(runStall(entry({ lastBeatAt: 'not a date' }), NOW)).toEqual({ stalled: true, sinceMs: null })
  })
})

describe('the overseer lease -- the alarm', () => {
  const held = (over: Partial<EpicLease> = {}): EpicLease => ({
    convId: 'abcdef1234',
    gen: 4,
    at: iso(30_000),
    ...over,
  })

  it('reads a live, recent holder as healthy', () => {
    expect(leaseState(held(), true, NOW)).toEqual({ kind: 'held', sinceMs: 30_000, holder: 'abcdef12', gen: 4 })
  })

  it('is STALE when the holder conversation is gone -- the 2026-08-18 failure', () => {
    expect(leaseState(held(), false, NOW).kind).toBe('stale')
  })

  it('is STALE when a live holder has held it past the shared threshold', () => {
    expect(leaseState(held({ at: iso(LEASE_STALE_MS + 1000) }), true, NOW).kind).toBe('stale')
  })

  it('separates NEVER RAN from RAN AND RELEASED -- different facts', () => {
    expect(leaseState(null, true, NOW).kind).toBe('never')
    expect(leaseState({ convId: '', gen: 7, at: '' }, true, NOW)).toMatchObject({ kind: 'released', gen: 7 })
  })
})

describe('the tails', () => {
  const log = (ts: string, body: string): EpicLogEntry => ({ ts, kind: 'dispatch', convId: 'c', body })

  it('shows the baton NEWEST FIRST from an oldest-first log', () => {
    const baton = [log(iso(300_000), 'old'), log(iso(200_000), 'mid'), log(iso(100_000), 'new')]
    expect(batonTail(baton, 2).map(e => e.body)).toEqual(['new', 'mid'])
  })

  it('keeps beats OLDEST-LEFT and marks the ones that did nothing', () => {
    const beat = (n: number, actions: number): EpicBeatRecord => ({
      at: iso(n),
      gen: 1,
      epicId: 'e',
      project: 'p',
      note: '',
      actions,
      spawned: [],
    })
    expect(beatTicks([beat(300, 0), beat(200, 2), beat(100, 0)], 2)).toEqual([
      { at: iso(200), did: true },
      { at: iso(100), did: false },
    ])
  })
})

describe('nightshift counts', () => {
  const task = (status: NightshiftTaskMeta['status']): NightshiftTaskMeta => ({
    id: status,
    title: status,
    project: 'p',
    status,
    verdict: 'ready-to-review',
    feasibility: 'feasible',
    created: iso(0),
  })

  it('folds every terminal lane into SETTLED and counts spinning as running', () => {
    const tasks = [
      task('queued'),
      task('queued'),
      task('running'),
      task('spinning'),
      task('done'),
      task('integrated'),
      task('blocked'),
      task('errored'),
      task('skipped'),
      task('discarded'),
    ]
    expect(nightshiftCounts(tasks)).toEqual({ queued: 2, running: 2, settled: 6 })
  })
})
