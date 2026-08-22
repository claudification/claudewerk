import { describe, expect, test } from 'bun:test'
import {
  elapsedRunMinutes,
  epicRunCaps,
  formatEpicRunCaps,
  formatUsd,
  readCeiling,
  unenforceableCapFields,
  unenforceableCapLine,
} from './epic-run-caps'
import type { EpicRunReading } from './epic-run-types'

const T0 = Date.parse('2026-08-21T00:00:00.000Z')
const at = (minutes: number) => T0 + minutes * 60_000

const RUN: EpicRunReading = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: ['now'],
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  unlandedWoken: '',
  maxGens: 40,
  maxUsd: 100,
  maxWallClockMinutes: 480,
  spentUsd: 0,
  legBudgetUsd: 200,
  legStartUsd: 0,
  leg: 1,
  concurrency: 3,
  // LEGS NEED `plan` ON -- a leg boundary IS a re-plan, so a run that opted out
  // of planning generations has no legs (`legsArmed`). The fixture carries it so
  // the readings below are about the arithmetic rather than about the opt-out.
  plan: true,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

const run = (over: Partial<EpicRunReading> = {}): EpicRunReading => ({ ...RUN, ...over })
const byLabel = (r: EpicRunReading, nowMs: number, label: string) => epicRunCaps(r, nowMs).find(c => c.label === label)

describe('elapsedRunMinutes', () => {
  test('is null before the clock starts -- a window run waiting for the night owes nothing', () => {
    expect(elapsedRunMinutes(run(), T0)).toBeNull()
  })

  test('counts whole minutes since startedAt', () => {
    expect(elapsedRunMinutes(run({ startedAt: '2026-08-21T00:00:00.000Z' }), at(90))).toBe(90)
  })

  test('an unparseable stamp reads as no clock rather than as NaN minutes', () => {
    expect(elapsedRunMinutes(run({ startedAt: 'whenever' }), at(90))).toBeNull()
  })
})

describe('epicRunCaps', () => {
  test('reports every ceiling, money first -- run spend, then the leg, then time', () => {
    expect(epicRunCaps(run(), T0).map(c => c.label)).toEqual(['spend', 'leg 1 spend', 'wall clock', 'generations'])
  })

  test('the leg is measured from its own watermark, not from the run total', () => {
    expect(byLabel(run({ spentUsd: 512, legStartUsd: 400, leg: 3 }), T0, 'leg 3 spend')).toMatchObject({
      used: '$112.00',
      limit: '$200.00',
      remaining: '$88.00',
      over: false,
    })
  })

  /**
   * `over` ON A LEG IS NOT `over` ON A RUN, and this test is the difference.
   *
   * Every other reading in this file goes `over` when a brake has FIRED. A leg
   * over its budget has stopped dispatching and is settling its in-flight work
   * before it re-plans -- the engine working, not a run that stopped -- and the
   * surface has to be able to say so without borrowing the vocabulary of a park.
   */
  test('a leg past its budget reads OVER while the run itself is nowhere near its ceiling', () => {
    const r = run({ maxUsd: 5000, spentUsd: 220, legStartUsd: 0 })
    expect(byLabel(r, T0, 'leg 1 spend')?.over).toBe(true)
    expect(byLabel(r, T0, 'spend')?.over).toBe(false)
  })

  test('a lost legBudgetUsd is UNENFORCEABLE, never $0.00 and never no cap', () => {
    const blind = { ...run(), legBudgetUsd: undefined } as unknown as Parameters<typeof epicRunCaps>[0]
    expect(byLabel(blind, T0, 'leg spend')).toMatchObject({ limit: 'UNENFORCEABLE', over: false })
  })

  test('spend shows what is left, to the cent', () => {
    expect(byLabel(run({ spentUsd: 12.5 }), T0, 'spend')).toMatchObject({
      used: '$12.50',
      limit: '$100.00',
      remaining: '$87.50',
      over: false,
    })
  })

  test('a tripped ceiling says so', () => {
    expect(byLabel(run({ spentUsd: 100 }), T0, 'spend')?.over).toBe(true)
  })

  test('remaining never goes negative -- an overspent run is at 0 left, not at minus', () => {
    expect(byLabel(run({ spentUsd: 140 }), T0, 'spend')?.remaining).toBe('$0.00')
  })

  test('a disarmed cap has no limit and no remaining, rather than a limit of zero', () => {
    expect(byLabel(run({ maxUsd: 0, spentUsd: 9 }), T0, 'spend')).toMatchObject({
      limit: 'no cap',
      remaining: null,
      over: false,
    })
  })

  test('a wall clock that has not started reports no elapsed and no remaining', () => {
    expect(byLabel(run(), T0, 'wall clock')).toMatchObject({ used: 'not started', remaining: null, over: false })
  })

  test('a started wall clock counts up and down', () => {
    expect(byLabel(run({ startedAt: '2026-08-21T00:00:00.000Z' }), at(37), 'wall clock')).toMatchObject({
      used: '37 min',
      limit: '480 min',
      remaining: '443 min',
    })
  })
})

describe('formatEpicRunCaps', () => {
  test('is one line a human and an agent can both read', () => {
    const line = formatEpicRunCaps(run({ spentUsd: 12.5, startedAt: '2026-08-21T00:00:00.000Z' }), at(37))
    expect(line).toBe(
      'spend $12.50/$100.00 ($87.50 left) . leg 1 spend $12.50/$200.00 ($187.50 left) . ' +
        'wall clock 37 min/480 min (443 min left) . generations 3/40 (37 left)',
    )
  })

  test('marks the ceiling that actually stopped the run', () => {
    expect(formatEpicRunCaps(run({ spentUsd: 250 }), T0)).toContain('spend $250.00/$100.00 ($0.00 left) OVER')
  })

  /**
   * A RUN WAITING ON AN APPOINTMENT ANSWERS THE SAME QUESTION THE CEILINGS DO --
   * "why is this not moving, and how long until it is" -- so it belongs on the
   * same line rather than in a fourth place a reader has to know to look. Every
   * text surface that prints the caps (the `epic_run` tool's header, the
   * werk-master's briefing) gets it from here, so none of them can disagree with the
   * beat that is holding the run.
   */
  test('carries the appointment a waiting run is held on, with its zone and a countdown', () => {
    const line = formatEpicRunCaps(run({ cadence: ['at:2026-08-21T11:00:00+07:00'] }), T0)
    expect(line).toContain('waiting until 2026-08-21T11:00:00+07:00 (in 4 hours)')
    expect(line).toContain('spend $0.00/$100.00')
  })

  test('says nothing about an appointment that has already passed', () => {
    const line = formatEpicRunCaps(run({ cadence: ['at:2026-08-20T11:00:00+07:00'] }), T0)
    expect(line).not.toContain('waiting until')
  })
})

test('formatUsd always shows cents', () => {
  expect(formatUsd(12.5)).toBe('$12.50')
  expect(formatUsd(0)).toBe('$0.00')
})

/**
 * ABSENT, ZERO AND UNREADABLE ARE THREE ANSWERS.
 *
 * `run.maxUsd > 0` had two branches for three cases, and it folded the dangerous
 * one into the permissive one: a ceiling asked for and lost in transit read as
 * "no ceiling was asked for". These pin the third state existing at all, because
 * every refusal downstream is built on being able to name it.
 */
describe('readCeiling -- absent is not zero and zero is not absent', () => {
  test('a positive number is a live ceiling', () => {
    expect(readCeiling(100)).toEqual({ kind: 'capped', limit: 100 })
  })

  test('a typed zero is a deliberate disarm', () => {
    expect(readCeiling(0)).toEqual({ kind: 'disarmed' })
  })

  test('absent is UNENFORCEABLE, never unlimited -- this is the whole card', () => {
    expect(readCeiling(undefined).kind).toBe('unenforceable')
    expect(readCeiling(null).kind).toBe('unenforceable')
  })

  test('a negative ceiling does not get to be a second spelling of the disarm', () => {
    expect(readCeiling(-1).kind).toBe('unenforceable')
  })

  test('a string that survived a YAML round trip is unenforceable rather than NaN', () => {
    expect(readCeiling('100').kind).toBe('unenforceable')
    expect(readCeiling(Number.NaN).kind).toBe('unenforceable')
  })
})

/**
 * THE CAPABILITY PROBE. A sentinel bundle built before the ceilings landed
 * answers a `get` with all three scalars absent, and the run it sends back is
 * the only place that fact is visible -- so the check is a property of the data
 * and needs no version handshake to keep in step.
 */
describe('unenforceableCapFields -- the probe', () => {
  test('a healthy run has nothing to report', () => {
    expect(unenforceableCapFields(run())).toEqual([])
    expect(unenforceableCapLine(run())).toBeNull()
  })

  test('a run with every cap DISARMED is still enforceable -- a typed 0 is an answer', () => {
    expect(unenforceableCapFields(run({ maxUsd: 0, maxWallClockMinutes: 0 }))).toEqual([])
  })

  test('a reply from a bundle that predates the ceilings names all three', () => {
    const stale = { ...run() } as Partial<EpicRunReading>
    stale.maxUsd = undefined
    stale.maxWallClockMinutes = undefined
    stale.spentUsd = undefined
    expect(unenforceableCapFields(stale)).toEqual(['maxUsd', 'maxWallClockMinutes', 'spentUsd'])
    expect(unenforceableCapLine(stale)).toContain('maxUsd (absent')
  })

  test('one lost field is enough -- the line names it and says why', () => {
    const partial = { ...run() } as Partial<EpicRunReading>
    partial.spentUsd = undefined
    expect(unenforceableCapFields(partial)).toEqual(['spentUsd'])
    expect(unenforceableCapLine(partial)).toBe('spentUsd (absent -- the writer of run.md does not carry this field)')
  })
})

/**
 * WHAT A SURFACE PRINTS WHEN THE CEILING IS LOST. `$0.00/no cap` in this slot is
 * the exact lie the card exists to stop telling, and `over: false` is deliberate
 * -- the run has not reached its ceiling, it has lost it.
 */
describe('the readings render the third state instead of inventing a number', () => {
  const blind = (over: Partial<Record<keyof EpicRunReading, undefined>>) =>
    ({ ...run(), ...over }) as unknown as EpicRunReading

  test('a lost maxUsd reads UNENFORCEABLE, not "no cap"', () => {
    expect(byLabel(blind({ maxUsd: undefined }), T0, 'spend')).toMatchObject({
      used: '?',
      limit: 'UNENFORCEABLE',
      remaining: null,
      over: false,
    })
  })

  test('a lost LEDGER is as unjudgeable as a lost ceiling -- $0.00 spent would read as room to burn', () => {
    const reading = byLabel(blind({ spentUsd: undefined }), T0, 'spend')
    expect(reading?.limit).toBe('UNENFORCEABLE')
    expect(reading?.unenforceable).toContain('spentUsd')
  })

  test('a lost maxWallClockMinutes reads the same way', () => {
    expect(byLabel(blind({ maxWallClockMinutes: undefined }), T0, 'wall clock')?.limit).toBe('UNENFORCEABLE')
  })

  test('the one-line format carries the reason, so an agent reading it knows which field went', () => {
    const line = formatEpicRunCaps(blind({ maxUsd: undefined }), T0)
    expect(line).toContain('spend ?/UNENFORCEABLE (maxUsd absent')
  })
})
