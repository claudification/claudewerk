import { describe, expect, test } from 'bun:test'
import { isVitallyLive, type RunVitalityInput, runVitality } from './epic-vitality'

const BEAT = '2026-08-20T07:34:10.409Z'

function input(over: Partial<RunVitalityInput> = {}): RunVitalityInput {
  return {
    status: 'running',
    inFlight: 0,
    werkMasterAlive: false,
    armed: true,
    lastBeatAt: BEAT,
    stale: false,
    ...over,
  }
}

describe('runVitality', () => {
  /**
   * THE LIE THIS MODULE EXISTS TO KILL. `epic-the-wall-ii`, 2026-08-20: status
   * `running`, armed forgotten by a broker restart, werk-master conversation ended,
   * zero seats -- and every surface printed RUNNING.
   */
  test('a status of running with no seat at all is NOT reported as running', () => {
    const out = runVitality(input({ armed: false, inFlight: 0, werkMasterAlive: false }))
    expect(out.vitality).toBe('idle')
    expect(out.label).toBe('IDLE')
    expect(out.breathing).toBe(false)
  })

  test('the idle sentence says WHY, including that the armed set forgot it', () => {
    expect(runVitality(input({ armed: false })).why).toContain('armed set')
  })

  test('a working seat is the only thing that earns RUNNING', () => {
    const out = runVitality(input({ inFlight: 2 }))
    expect(out.label).toBe('RUNNING')
    expect(out.breathing).toBe(true)
    expect(out.why).toContain('2 seat')
  })

  test('an awake werk-master counts as working even before it dispatches', () => {
    expect(runVitality(input({ werkMasterAlive: true })).vitality).toBe('working')
  })

  test('a quiet sweep is STALLED, whatever the status says', () => {
    const out = runVitality(input({ stale: true, inFlight: 1 }))
    expect(out.label).toBe('STALLED')
    expect(out.breathing).toBe(false)
  })

  test('armed and never beaten with nothing to pick it up is STALLED, not armed', () => {
    expect(runVitality(input({ lastBeatAt: null, armed: false })).vitality).toBe('stalled')
  })

  test('armed and awaiting its first beat is ARMED, not stalled', () => {
    expect(runVitality(input({ lastBeatAt: null, armed: true })).label).toBe('ARMED')
  })

  /** "When it's done, it's done" -- not armed, not paused, and still visible. */
  test('a complete run reads DONE and is not live', () => {
    const out = runVitality(input({ status: 'complete' }))
    expect(out.label).toBe('DONE')
    expect(out.live).toBe(false)
    expect(isVitallyLive(input({ status: 'complete' }))).toBe(false)
  })

  test('paused and aborted keep their own words', () => {
    expect(runVitality(input({ status: 'paused' })).label).toBe('PAUSED')
    expect(runVitality(input({ status: 'aborted' })).label).toBe('ABORTED')
  })

  test('a terminal status wins over a late settle that still looks busy', () => {
    expect(runVitality(input({ status: 'aborted', inFlight: 3 })).vitality).toBe('aborted')
  })

  test('an unreadable run says so instead of guessing', () => {
    expect(runVitality(input({ status: null })).label).toBe('NO RUN')
  })
})
