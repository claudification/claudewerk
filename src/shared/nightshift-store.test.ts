/**
 * Tier 1 unit tests for the NIGHTSHIFT artifact store -- the on-disk keystone
 * (plan-nightshift.md §3). Round-trips frontmatter through the canonical layout,
 * exercises the `latest` symlink resolution, the safe-to-do (skipped) lane, and
 * the snapshot the Result screen reads.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendSkipped,
  dequeueTask,
  enqueueTask,
  finalizeRun,
  hasRecentRun,
  listQueue,
  listRunSkipped,
  listRunTasks,
  patchTask,
  readLatestSnapshot,
  readNightshiftConfig,
  resolveLatestRunId,
  startRun,
  writeBlocked,
  writeNightshiftConfig,
  writeTask,
} from './nightshift-store'
import { DEFAULT_NIGHTSHIFT_CONFIG } from './nightshift-types'

let root: string
const NOW = Date.UTC(2026, 5, 19, 3, 14, 0) // 2026-06-19T03:14:00Z

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nightshift-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('config.json', () => {
  test('absent config returns the recommended defaults', () => {
    const cfg = readNightshiftConfig(root)
    expect(cfg).toEqual(DEFAULT_NIGHTSHIFT_CONFIG)
    expect(cfg.mergePolicy).toBe('branch-for-review')
    // `auto`, not `dontAsk`: the H1 field finding (2026-07-05) was that a worker
    // under `dontAsk` can do nothing at all without an allowlist nobody can
    // enumerate, so the documented default described a run that could not work.
    expect(cfg.permissionMode).toBe('auto')
  })

  test('write then read round-trips + merges over defaults', () => {
    writeNightshiftConfig(root, { ...DEFAULT_NIGHTSHIFT_CONFIG, enabled: true, window: '01:00-07:00' })
    const cfg = readNightshiftConfig(root)
    expect(cfg.enabled).toBe(true)
    expect(cfg.window).toBe('01:00-07:00')
    // unsupplied fields fall back to the default merge
    expect(cfg.mergePolicy).toBe('branch-for-review')
  })

  test('corrupt config falls back to defaults, never throws', () => {
    writeNightshiftConfig(root, DEFAULT_NIGHTSHIFT_CONFIG)
    rmSync(join(root, '.nightshift', 'config.json'))
    Bun.write(join(root, '.nightshift', 'config.json'), '{ not json')
    expect(readNightshiftConfig(root).mergePolicy).toBe('branch-for-review')
  })
})

describe('run lifecycle + latest symlink', () => {
  test('startRun creates run.md, tasks/blocked dirs, and points latest', () => {
    const run = startRun(root, { runId: '2026-06-19', taskCount: 3, window: '01:00-07:00' }, NOW)
    expect(run.status).toBe('running')
    expect(existsSync(join(root, '.nightshift', 'runs', '2026-06-19', 'run.md'))).toBe(true)
    expect(resolveLatestRunId(root)).toBe('2026-06-19')
  })

  test('startRun is idempotent for the same runId', () => {
    const a = startRun(root, { runId: '2026-06-19', taskCount: 3 }, NOW)
    const b = startRun(root, { runId: '2026-06-19', taskCount: 99 }, NOW + 1000)
    expect(b.created).toBe(a.created)
    expect(b.taskCount).toBe(3) // second call did not clobber
  })

  test('finalize recomputes totals from disk + flips to done', () => {
    startRun(root, { runId: '2026-06-19', taskCount: 3 }, NOW)
    writeTask(
      root,
      '2026-06-19',
      { id: '1', title: 'A', project: 'p', status: 'done', verdict: 'ready-to-review', feasibility: 'feasible' },
      NOW,
    )
    writeTask(
      root,
      '2026-06-19',
      { id: '2', title: 'B', project: 'p', status: 'errored', verdict: 'needs-you', feasibility: 'feasible' },
      NOW,
    )
    writeBlocked(root, '2026-06-19', { id: '3', title: 'C', project: 'p', question: 'A or B?' }, NOW)
    appendSkipped(
      root,
      '2026-06-19',
      { id: '4', title: 'D', project: 'p', reason: 'unsafe', feasibility: 'infeasible' },
      NOW,
    )

    const run = finalizeRun(root, '2026-06-19', { digest: 'one ready, one errored', cost_usd: 0.4 }, NOW + 5000)
    expect(run).not.toBeNull()
    expect(run?.status).toBe('done')
    expect(run?.totals).toEqual({ ready: 1, blocked: 1, skipped: 1, errored: 1 })
    expect(run?.digest).toBe('one ready, one errored')
    expect(run?.finished).toBeTruthy()
  })

  test('finalize on a missing run returns null', () => {
    expect(finalizeRun(root, 'nope', {}, NOW)).toBeNull()
  })
})

describe('task artifact frontmatter', () => {
  test('writeTask persists every §3 field + the body sections', () => {
    writeTask(
      root,
      '2026-06-19',
      {
        id: '2',
        title: 'Fix worktree-remove silent failure',
        project: 'remote-claude',
        status: 'done',
        verdict: 'ready-to-review',
        feasibility: 'feasible',
        branch: 'nightshift/002-worktree-remove-fix',
        diffstat: '+31 -6',
        files: ['scripts/worktree-remove.sh'],
        tests: 'pass',
        report: { recap: 'made it loud', howToVerify: 'bun test worktree', openLoops: [] },
      },
      NOW,
    )
    const [t] = listRunTasks(root, '2026-06-19')
    expect(t.id).toBe('2')
    expect(t.verdict).toBe('ready-to-review')
    expect(t.feasibility).toBe('feasible')
    expect(t.files).toEqual(['scripts/worktree-remove.sh'])
    expect(t.tests).toBe('pass')
    // file name is NNN-slug.md
    const raw = readFileSync(
      join(root, '.nightshift', 'runs', '2026-06-19', 'tasks', '002-fix-worktree-remove-silent-failure.md'),
      'utf8',
    )
    expect(raw).toContain('## What it did')
    expect(raw).toContain('made it loud')
    expect(raw).toContain('## Open loops')
    expect(raw).toContain('- none')
  })
})

describe('safe-to-do (skipped) lane', () => {
  test('appendSkipped accumulates parseable entries', () => {
    appendSkipped(
      root,
      '2026-06-19',
      { id: '5', title: 'Rewrite auth', project: 'p', reason: 'too vague', feasibility: 'infeasible' },
      NOW,
    )
    appendSkipped(
      root,
      '2026-06-19',
      { id: '6', title: 'Delete prod db', project: 'p', reason: 'irreversible', feasibility: 'infeasible' },
      NOW,
    )
    const skipped = listRunSkipped(root, '2026-06-19')
    expect(skipped).toHaveLength(2)
    expect(skipped[0].title).toBe('Rewrite auth')
    expect(skipped[0].reason).toBe('too vague')
    expect(skipped[1].feasibility).toBe('infeasible')
  })
})

describe('patchTask (act-on-results, plan §4)', () => {
  function seedReady() {
    writeTask(
      root,
      '2026-06-19',
      {
        id: '2',
        title: 'Fix worktree-remove silent failure',
        project: 'remote-claude',
        status: 'done',
        verdict: 'ready-to-review',
        feasibility: 'feasible',
        branch: 'nightshift/002-worktree-remove-fix',
        diffstat: '+31 -6',
        tests: 'pass',
        report: { recap: 'made it loud', howToVerify: 'bun test worktree' },
      },
      NOW,
    )
  }

  test('merges scalars in place without clobbering the worker fields', () => {
    seedReady()
    const patched = patchTask(root, '2026-06-19', { id: '2', status: 'integrated', commits: 2 }, NOW + 1000)
    expect(patched?.status).toBe('integrated')
    expect(patched?.commits).toBe(2)
    // untouched fields survive
    expect(patched?.branch).toBe('nightshift/002-worktree-remove-fix')
    expect(patched?.diffstat).toBe('+31 -6')
    expect(patched?.tests).toBe('pass')
    // reflected on disk
    const [t] = listRunTasks(root, '2026-06-19')
    expect(t.status).toBe('integrated')
    expect(t.verdict).toBe('ready-to-review')
  })

  test('note appends to the Notes / decisions section, replacing the placeholder', () => {
    seedReady()
    patchTask(root, '2026-06-19', { id: '2', tests: 'fail', note: 'acceptance regressed on re-run' }, NOW)
    const raw = readFileSync(
      join(root, '.nightshift', 'runs', '2026-06-19', 'tasks', '002-fix-worktree-remove-silent-failure.md'),
      'utf8',
    )
    expect(raw).toContain('## Notes / decisions')
    expect(raw).toContain('- acceptance regressed on re-run')
    expect(raw).not.toContain('_none_')
    // body sections preserved
    expect(raw).toContain('## What it did')
    expect(raw).toContain('made it loud')
    expect(raw).toContain('## Open loops')
  })

  test('discard outcome flips status + verdict', () => {
    seedReady()
    const patched = patchTask(
      root,
      '2026-06-19',
      { id: '2', status: 'discarded', verdict: 'declined', note: 'discarded: not worth it' },
      NOW,
    )
    expect(patched?.status).toBe('discarded')
    expect(patched?.verdict).toBe('declined')
  })

  test('unknown id returns null', () => {
    expect(patchTask(root, '2026-06-19', { id: '99', status: 'integrated' }, NOW)).toBeNull()
  })
})

describe('snapshot (Result screen payload)', () => {
  test('readLatestSnapshot returns the latest run + all lanes', () => {
    startRun(root, { runId: '2026-06-18', taskCount: 1 }, NOW - 86_400_000)
    startRun(root, { runId: '2026-06-19', taskCount: 2 }, NOW)
    writeTask(
      root,
      '2026-06-19',
      { id: '1', title: 'A', project: 'p', status: 'done', verdict: 'ready-to-review', feasibility: 'feasible' },
      NOW,
    )
    writeBlocked(root, '2026-06-19', { id: '2', title: 'B', project: 'p', question: 'which way?' }, NOW)
    finalizeRun(root, '2026-06-19', { digest: 'd' }, NOW + 1)

    const snap = readLatestSnapshot(root)
    expect(snap?.run.runId).toBe('2026-06-19')
    expect(snap?.tasks).toHaveLength(1)
    expect(snap?.blocked).toHaveLength(1)
    expect(snap?.blocked[0].question).toBe('which way?')
  })

  test('no runs -> null snapshot', () => {
    expect(readLatestSnapshot(root)).toBeNull()
  })
})

describe('queue lane (assigned, awaiting a run)', () => {
  test('enqueueTask assigns 001 then 002, writes the file + body', () => {
    const a = enqueueTask(root, { title: 'First task', project: 'p', description: 'do the thing' }, NOW)
    const b = enqueueTask(root, { title: 'Second task', project: 'p' }, NOW + 1000)
    expect(a.id).toBe('001')
    expect(b.id).toBe('002')
    expect(a.status).toBe('queued')
    expect(existsSync(join(root, '.nightshift', 'queue', '001-first-task.md'))).toBe(true)
    const raw = readFileSync(join(root, '.nightshift', 'queue', '001-first-task.md'), 'utf8')
    expect(raw).toContain('## Task')
    expect(raw).toContain('do the thing')
    // missing description -> placeholder body
    expect(b.body).toContain('_no description_')
  })

  test('enqueueTask round-trips the optional fields', () => {
    enqueueTask(
      root,
      {
        title: 'Promoted task',
        project: 'p',
        acceptance: 'tests pass',
        feasibility: 'uncertain',
        risk: 'medium',
        source: 'board',
        boardRef: 'b-42',
      },
      NOW,
    )
    const [q] = listQueue(root)
    expect(q.acceptance).toBe('tests pass')
    expect(q.feasibility).toBe('uncertain')
    expect(q.risk).toBe('medium')
    expect(q.source).toBe('board')
    expect(q.boardRef).toBe('b-42')
  })

  test('listQueue returns items sorted by id ascending', () => {
    enqueueTask(root, { title: 'Alpha', project: 'p' }, NOW)
    enqueueTask(root, { title: 'Beta', project: 'p' }, NOW)
    enqueueTask(root, { title: 'Gamma', project: 'p' }, NOW)
    const q = listQueue(root)
    expect(q.map(i => i.id)).toEqual(['001', '002', '003'])
    expect(q.map(i => i.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  test('listQueue tolerates a missing queue dir', () => {
    expect(listQueue(root)).toEqual([])
  })

  test('dequeueTask removes by id, false for a missing id', () => {
    enqueueTask(root, { title: 'Keep me', project: 'p' }, NOW)
    enqueueTask(root, { title: 'Drop me', project: 'p' }, NOW)
    expect(dequeueTask(root, '2')).toBe(true)
    expect(listQueue(root).map(i => i.id)).toEqual(['001'])
    expect(dequeueTask(root, '99')).toBe(false)
  })
})

describe('hasRecentRun', () => {
  test('false when there are no runs', () => {
    expect(hasRecentRun(root, NOW)).toBe(false)
  })

  test('true when a run dir is within the window', () => {
    startRun(root, { runId: '2026-06-19' }, NOW)
    expect(hasRecentRun(root, NOW)).toBe(true)
  })

  test('false when the only run is older than 7 days', () => {
    startRun(root, { runId: '2026-06-01' }, NOW - 18 * 86_400_000)
    expect(hasRecentRun(root, NOW)).toBe(false)
  })
})
