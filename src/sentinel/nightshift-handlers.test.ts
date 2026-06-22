/**
 * Tier 1 unit tests for the NIGHTSHIFT sentinel op handler -- the broker<->sentinel
 * RPC surface. One op-envelope in, one result out; the safe-to-do gate rides the
 * `report` op with kind=skipped.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NightshiftOp } from '../shared/protocol'
import { handleNightshiftOp } from './nightshift-handlers'

let root: string
const NOW = Date.UTC(2026, 5, 19, 3, 14, 0)

function op(o: Omit<NightshiftOp, 'type' | 'requestId' | 'projectRoot'>): NightshiftOp {
  return { type: 'nightshift_op', requestId: 'r1', projectRoot: root, ...o }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nightshift-handlers-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('config ops', () => {
  test('config_read returns defaults for a fresh project', () => {
    const r = handleNightshiftOp(root, op({ op: 'config_read' }), NOW)
    expect(r.ok).toBe(true)
    expect(r.config?.mergePolicy).toBe('branch-for-review')
    expect(r.requestId).toBe('r1')
  })

  test('config_write persists then echoes back the effective config', () => {
    const cfg = {
      enabled: true,
      mergePolicy: 'branch-for-review' as const,
      permissionMode: 'dontAsk' as const,
      window: '02:00-06:00',
    }
    const r = handleNightshiftOp(root, op({ op: 'config_write', config: cfg }), NOW)
    expect(r.ok).toBe(true)
    expect(r.config?.window).toBe('02:00-06:00')
    // re-read confirms persistence
    expect(handleNightshiftOp(root, op({ op: 'config_read' }), NOW).config?.enabled).toBe(true)
  })

  test('config_write without a config payload errors cleanly', () => {
    const r = handleNightshiftOp(root, op({ op: 'config_write' }), NOW)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('config required')
  })
})

describe('run + report ops', () => {
  test('full manual run: start -> report task/skipped/blocked -> finalize -> snapshot', () => {
    expect(
      handleNightshiftOp(root, op({ op: 'run_start', runStart: { runId: '2026-06-19', taskCount: 3 } }), NOW).ok,
    ).toBe(true)

    const taskRes = handleNightshiftOp(
      root,
      op({
        op: 'report',
        runId: '2026-06-19',
        report: {
          kind: 'task',
          id: '1',
          title: 'Add token-flow tests',
          project: 'remote-claude',
          status: 'done',
          verdict: 'ready-to-review',
          feasibility: 'feasible',
          diffstat: '+120 -0',
          tests: 'pass',
        },
      }),
      NOW,
    )
    expect(taskRes.ok).toBe(true)
    expect(taskRes.task?.verdict).toBe('ready-to-review')

    // the safe-to-do gate declines an unsafe order
    const skipRes = handleNightshiftOp(
      root,
      op({
        op: 'report',
        runId: '2026-06-19',
        report: {
          kind: 'skipped',
          id: '2',
          title: 'Rewrite the auth layer',
          project: 'remote-claude',
          reason: 'too vague to verify',
          feasibility: 'infeasible',
        },
      }),
      NOW,
    )
    expect(skipRes.ok).toBe(true)
    expect(skipRes.skipped?.feasibility).toBe('infeasible')

    const blockRes = handleNightshiftOp(
      root,
      op({
        op: 'report',
        runId: '2026-06-19',
        report: {
          kind: 'blocked',
          id: '3',
          title: 'Auth guard',
          project: 'remote-claude',
          question: 'Cookie or bearer?',
          options: ['cookie', 'bearer'],
        },
      }),
      NOW,
    )
    expect(blockRes.ok).toBe(true)
    expect(blockRes.blocked?.options).toEqual(['cookie', 'bearer'])

    const fin = handleNightshiftOp(
      root,
      op({ op: 'run_finalize', runId: '2026-06-19', finalize: { digest: 'the night in one glance' } }),
      NOW + 9000,
    )
    expect(fin.ok).toBe(true)
    expect(fin.run?.status).toBe('done')
    expect(fin.run?.totals).toEqual({ ready: 1, blocked: 1, skipped: 1, errored: 0 })

    const snap = handleNightshiftOp(root, op({ op: 'snapshot' }), NOW)
    expect(snap.ok).toBe(true)
    expect(snap.snapshot?.run.digest).toBe('the night in one glance')
    expect(snap.snapshot?.tasks).toHaveLength(1)
    expect(snap.snapshot?.skipped).toHaveLength(1)
    expect(snap.snapshot?.blocked).toHaveLength(1)
  })

  test('report without a runId errors', () => {
    const r = handleNightshiftOp(
      root,
      op({ op: 'report', report: { kind: 'task', id: '1', title: 'x', project: 'p' } }),
      NOW,
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('runId required')
  })

  test('snapshot of an empty project is ok with a null snapshot', () => {
    const r = handleNightshiftOp(root, op({ op: 'snapshot' }), NOW)
    expect(r.ok).toBe(true)
    expect(r.snapshot).toBeNull()
  })

  test('finalize of an unknown run errors', () => {
    const r = handleNightshiftOp(root, op({ op: 'run_finalize', runId: 'ghost' }), NOW)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('run not found')
  })
})
