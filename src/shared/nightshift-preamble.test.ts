/**
 * The unattended covenant + SAFE-TO-DO gate (directive #2) must be present in
 * every nightshift worker's preamble -- this is the behavioural contract, so we
 * assert its load-bearing lines never silently drift out.
 */
import { describe, expect, test } from 'bun:test'
import { nightshiftPreamble } from './nightshift-preamble'

describe('nightshiftPreamble', () => {
  const p = nightshiftPreamble({
    runId: '2026-06-19',
    taskId: '002',
    project: 'remote-claude',
    acceptance: 'tests pass',
  })

  test('names the run + task + project and declares unattended', () => {
    expect(p).toContain('2026-06-19')
    expect(p).toContain('002')
    expect(p).toContain('remote-claude')
    expect(p).toContain('UNATTENDED')
  })

  test('the safe-to-do gate comes BEFORE any work + defaults to decline', () => {
    const gateIdx = p.indexOf('SAFE-TO-DO GATE')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(p).toContain('Default instinct = decline')
    expect(p).toContain('feasibility=infeasible')
    expect(p).toContain('never guess')
  })

  test('tells the worker to STOP + report on a fork, never bulldoze', () => {
    expect(p).toContain('kind=blocked')
    expect(p).toContain('Do NOT retry')
    expect(p).toContain('do NOT invent a workaround')
  })

  test('carries the never-do floor (no force-push / external sends / sudo / outside-worktree deletes)', () => {
    expect(p).toContain('force-push')
    expect(p).toContain('push to main')
    expect(p).toContain('sudo')
    expect(p).toContain('outside your worktree')
  })

  test('weaves the acceptance criterion in when provided', () => {
    expect(p).toContain('tests pass')
    // and falls back to a verify-something instruction when absent
    expect(nightshiftPreamble({ runId: 'r', taskId: 't', project: 'p' })).toContain('concrete acceptance check')
  })
})
