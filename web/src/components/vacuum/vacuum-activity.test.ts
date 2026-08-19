/**
 * @vitest-environment node
 */
/**
 * What the parked Vacuum tile is allowed to claim.
 *
 * The ordering is the whole test: a failure must never be buried under a
 * "running" that happens to still be set, and `done` must never be claimed by a
 * run that produced no steps at all.
 */

import type { VacuumStepMessage } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import { type VacuumWork, vacuumActivity } from './vacuum-activity'

function step(overrides: Partial<VacuumStepMessage> = {}): VacuumStepMessage {
  return {
    type: 'vacuum_step',
    runId: 'ab12cd34',
    step: 'archive:2026-05',
    status: 'ok',
    detail: '',
    rowsBefore: 10,
    rowsAfter: 10,
    dbBytesBefore: 1,
    dbBytesAfter: 1,
    initiator: 'user:jonas',
    dryRun: true,
    ts: 1,
    ...overrides,
  }
}

function work(overrides: Partial<VacuumWork> = {}): VacuumWork {
  return { mode: null, running: false, steps: [], error: null, loading: false, measuringBytes: false, ...overrides }
}

describe('vacuum activity', () => {
  it('is silent when nothing is happening', () => {
    expect(vacuumActivity(work())).toEqual({ status: 'idle' })
  })

  it('names the step it is on, and ticks per step', () => {
    const a = vacuumActivity(work({ mode: 'apply', running: true, steps: [step(), step({ step: 'vacuum' })] }))
    expect(a).toMatchObject({ status: 'running', label: 'vacuuming: vacuum', tick: 2 })
  })

  it('says so before the first step arrives', () => {
    expect(vacuumActivity(work({ mode: 'plan', running: true }))).toMatchObject({ label: 'dry run: starting' })
  })

  it('reports the long byte pass distinctly from the cheap measure', () => {
    expect(vacuumActivity(work({ measuringBytes: true })).label).toBe('measuring bytes')
    expect(vacuumActivity(work({ loading: true })).label).toBe('measuring')
  })

  it('reports a finished run with its size', () => {
    expect(vacuumActivity(work({ mode: 'plan', steps: [step(), step()] }))).toMatchObject({
      status: 'done',
      label: 'dry run: 2 steps',
    })
  })

  it('will NOT call a run done when a step failed', () => {
    const a = vacuumActivity(work({ mode: 'apply', steps: [step(), step({ step: 'gate', status: 'failed' })] }))
    expect(a).toMatchObject({ status: 'error', label: 'vacuuming failed: gate' })
  })

  it('puts a request failure above everything else', () => {
    const a = vacuumActivity(work({ mode: 'apply', running: true, steps: [step()], error: 'Admin access required' }))
    expect(a).toEqual({ status: 'error', label: 'Admin access required' })
  })

  it('does not claim done for a run that produced nothing', () => {
    expect(vacuumActivity(work({ mode: 'plan', steps: [] })).status).toBe('idle')
  })
})
