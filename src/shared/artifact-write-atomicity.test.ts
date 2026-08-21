/**
 * ONE CONTRACT, SIX MODULES: a failed artifact write leaves the previous file
 * intact and complete.
 *
 * `epic-artifact-writes-not-atomic` proved this for `epic-run-store`,
 * `md-section-log` and `project-store`; the same bare `writeFileSync` -- open
 * with O_TRUNC, then write -- was still in every other artifact writer in the
 * tree (`artifact-writes-not-atomic-elsewhere`). These are the remaining six.
 *
 * ONE FILE rather than a durability describe bolted onto six existing suites,
 * because it is ONE invariant and the interesting question about it is "which
 * writers are covered" -- a question you can only answer by reading them side by
 * side. Each module's own behavioural tests stay where they are.
 *
 * THE INJECTION, in the shape of `atomic-write.test.ts`: a DIRECTORY is planted
 * on the staging path, so the staging write fails with EISDIR at exactly the
 * moment a bare `writeFileSync` on the target would already have truncated it.
 * That it fails at all is also the proof the writer stages -- a writer still
 * writing the target directly would sail straight past a jammed sibling.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendSkipped,
  enqueueTask,
  finalizeRun,
  listRunSkipped,
  patchTask,
  startRun,
  writeBlocked,
  writeNightshiftConfig,
  writeTask,
} from './nightshift-store'
import { DEFAULT_NIGHTSHIFT_CONFIG } from './nightshift-types'
import { createProjectTask, setProjectTaskStatus, updateProjectTask } from './project-card-write'
import { fsStampDeps } from './project-doctor-created'
import { fsShapeRepairDeps } from './project-doctor-shape'
import { cardPath } from './project-paths'
import { upgradeProjectBoard } from './project-upgrade'
import { writeManifest } from './quest-manifest'
import { manifestFile } from './quest-paths'

const NOW = Date.parse('2026-08-22T09:00:00.000Z')
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artifact-atomicity-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Jam the staging sibling `writeFileAtomic` needs, so the next write to `file`
 *  fails before it can touch the target. */
function jamStaging(file: string): void {
  mkdirSync(`${file}.tmp`, { recursive: true })
}

/**
 * The assertion every case below shares: `write` throws, and the bytes on disk
 * are still exactly what they were. `before` is captured rather than passed so a
 * caller cannot accidentally assert against content the file never held.
 */
function survivesAFailedWrite(file: string, write: () => void): void {
  const before = readFileSync(file, 'utf8')
  expect(before.length).toBeGreaterThan(0)
  jamStaging(file)
  expect(write).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(before)
}

// ---------------------------------------------------------------------------
// project-card-write.ts -- THE ONE THAT MATTERS
// ---------------------------------------------------------------------------

/**
 * The board is the record the engine runs on, and `project_set_status` rewrites
 * a WHOLE card on every lane move. A torn card loses the frontmatter that
 * carries `epic:`, `depends_on:` and the promise ledger -- and it does so while
 * still existing and still parsing as something.
 */
describe('the board card writer', () => {
  const BODY = '## Spec\n\nA body long enough to need more than one write(2).\n'.repeat(40)

  function card(id = 'a-card'): string {
    createProjectTask(root, { title: id, body: BODY, epic: 'epic-project-runner', dependsOn: ['other'] }, NOW)
    return cardPath(root, id)
  }

  test('a failed create leaves nothing behind and does not claim the id', () => {
    const file = cardPath(root, 'a-card')
    jamStaging(file)
    expect(() => createProjectTask(root, { title: 'a card', body: BODY }, NOW)).toThrow()
    expect(existsSync(file)).toBe(false)
  })

  test('a failed patch leaves the previous card intact and complete', () => {
    const file = card()
    survivesAFailedWrite(file, () => updateProjectTask(root, 'a-card', { title: 'renamed', body: 'gone' }))
  })

  /** The lane move is the write that runs most often and the one an epic run
   *  makes unattended, so this is the tear that would actually have happened. */
  test('a failed lane move leaves the card -- epic, depends_on and all -- intact', () => {
    const file = card()
    survivesAFailedWrite(file, () => setProjectTaskStatus(root, 'a-card', 'done', NOW + 1))
    expect(readFileSync(file, 'utf8')).toContain('epic: epic-project-runner')
    expect(readFileSync(file, 'utf8')).toContain('status: inbox')
  })

  test('no staging sibling survives a successful write', () => {
    card()
    setProjectTaskStatus(root, 'a-card', 'open', NOW + 1)
    expect(readdirSync(join(root, '.rclaude', 'project', 'cards'))).toEqual(['a-card.md'])
  })
})

// ---------------------------------------------------------------------------
// nightshift-store.ts
// ---------------------------------------------------------------------------

describe('the nightshift store', () => {
  const RUN = '2026-08-22'
  const runFile = () => join(root, '.nightshift', 'runs', RUN, 'run.md')
  const tasksDir = () => join(root, '.nightshift', 'runs', RUN, 'tasks')
  const onlyFileIn = (dir: string) => join(dir, readdirSync(dir)[0] as string)

  test('a failed config write leaves the previous config intact', () => {
    writeNightshiftConfig(root, { ...DEFAULT_NIGHTSHIFT_CONFIG, enabled: true, window: '01:00-07:00' })
    survivesAFailedWrite(join(root, '.nightshift', 'config.json'), () =>
      writeNightshiftConfig(root, { ...DEFAULT_NIGHTSHIFT_CONFIG, enabled: false }),
    )
  })

  /** `finalizeRun` is the write that flips a run to done. Losing run.md loses
   *  the totals, the cost and the digest for the whole night. */
  test('a failed finalize leaves the running run.md intact', () => {
    startRun(root, { runId: RUN, taskCount: 3, digest: 'a digest with real prose in it' }, NOW)
    survivesAFailedWrite(runFile(), () => finalizeRun(root, RUN, { digest: 'final', cost_usd: 4 }, NOW + 1))
  })

  test('a failed task patch leaves the previous task artifact intact', () => {
    startRun(root, { runId: RUN }, NOW)
    writeTask(root, RUN, { id: '1', title: 'A task', project: 'p', status: 'running', feasibility: 'feasible' }, NOW)
    survivesAFailedWrite(onlyFileIn(tasksDir()), () =>
      patchTask(root, RUN, { id: '1', status: 'done', note: 'finished' }, NOW + 1),
    )
  })

  test('a failed blocked-card write leaves the previous question intact', () => {
    writeBlocked(root, RUN, { id: '2', title: 'B', project: 'p', question: 'A or B?' }, NOW)
    const dir = join(root, '.nightshift', 'runs', RUN, 'blocked')
    survivesAFailedWrite(onlyFileIn(dir), () =>
      writeBlocked(root, RUN, { id: '2', title: 'B', project: 'p', question: 'C?' }, NOW + 1),
    )
  })

  test('a failed enqueue leaves the queued task it would have overwritten intact', () => {
    enqueueTask(root, { title: 'Q', project: 'p', description: 'first' }, NOW)
    const dir = join(root, '.nightshift', 'queue')
    const file = onlyFileIn(dir)
    const before = readFileSync(file, 'utf8')
    // The next id is a fresh file, so jam THAT one: the failure must not take
    // the existing queue entry with it.
    jamStaging(join(dir, '002-q.md'))
    expect(() => enqueueTask(root, { title: 'Q', project: 'p', description: 'second' }, NOW + 1)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  /**
   * skipped.md APPENDS now -- it was `md-section-log`'s old read-whole-rewrite-
   * whole shape copied by hand, so a kill mid-rewrite destroyed the entire record
   * of what the nightshift declined rather than one entry of it.
   *
   * The newline guard is what bounds a POWER-LOSS tear to the torn entry alone:
   * `listRunSkipped` splits on `/^### /m`, so a header appended straight onto a
   * tail with no final newline is invisible to the reader and takes the good
   * entry with it.
   */
  describe('the skipped-entry log', () => {
    const skipped = (id: string, reason: string) => ({
      id,
      title: `T${id}`,
      project: 'p',
      reason,
      feasibility: 'infeasible' as const,
    })

    test('appends without rewriting the entries already there', () => {
      appendSkipped(root, RUN, skipped('1', 'unsafe'), NOW)
      const afterFirst = readFileSync(join(root, '.nightshift', 'runs', RUN, 'skipped.md'), 'utf8')
      appendSkipped(root, RUN, skipped('2', 'out of scope'), NOW + 1)
      const afterSecond = readFileSync(join(root, '.nightshift', 'runs', RUN, 'skipped.md'), 'utf8')
      expect(afterSecond.startsWith(afterFirst)).toBe(true)
      expect(listRunSkipped(root, RUN).map(s => s.id)).toEqual(['001', '002'])
    })

    test('a torn tail costs the torn entry and nothing after it', () => {
      appendSkipped(root, RUN, skipped('1', 'unsafe'), NOW)
      const file = join(root, '.nightshift', 'runs', RUN, 'skipped.md')
      // What a power loss mid-append leaves: a header, then a cut bullet and no
      // final newline.
      writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n### 002 T2\n- proj`, 'utf8')

      appendSkipped(root, RUN, skipped('3', 'duplicate'), NOW + 1)

      expect(listRunSkipped(root, RUN).map(s => s.id)).toEqual(['001', '002', '003'])
      expect(listRunSkipped(root, RUN).find(s => s.id === '003')?.reason).toBe('duplicate')
    })
  })
})

// ---------------------------------------------------------------------------
// quest-manifest.ts
// ---------------------------------------------------------------------------

describe('the quest manifest writer', () => {
  const manifest = (goal: string) => ({
    petname: 'swift-otter',
    project: 'claude://default/tmp/p',
    goal,
    target: 'branch' as const,
    status: 'running' as const,
    gate: 'auto' as const,
    contracts: [{ id: 'c1', statement: 'it builds', verify: 'bun test' }],
    created: '2026-08-22T09:00:00.000Z',
    updated: '2026-08-22T09:00:00.000Z',
  })

  test('a failed write leaves the previous manifest intact and complete', () => {
    writeManifest(root, manifest('the original goal, stated at some length'))
    survivesAFailedWrite(manifestFile(root, 'swift-otter'), () => writeManifest(root, manifest('replaced')))
  })
})

// ---------------------------------------------------------------------------
// project-upgrade.ts
// ---------------------------------------------------------------------------

/**
 * The migration is write-then-unlink, so a torn destination is worse than it
 * looks: the legacy card is deleted the moment the write RETURNS, and a half
 * card would be all that was left of it. The write failing has to leave the
 * legacy card standing for the next run.
 */
describe('the legacy card migration', () => {
  test('a failed migration keeps the legacy card and writes no partial', () => {
    const lane = join(root, '.rclaude', 'project', 'open')
    mkdirSync(lane, { recursive: true })
    const legacy = join(lane, 'a.md')
    writeFileSync(legacy, `---\ntitle: A\n---\n\n${'body\n'.repeat(200)}`, 'utf8')
    const dest = cardPath(root, 'a')
    jamStaging(dest)

    const report = upgradeProjectBoard(root, { nowMs: NOW })

    expect(report.moved).toEqual([])
    expect(report.failures.map(f => f.slug)).toEqual(['a'])
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(dest)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// project-doctor-shape.ts / project-doctor-created.ts
// ---------------------------------------------------------------------------

/**
 * Both doctors take their writer as an injected dep and both CATCH a write
 * failure, so the repair is simply not reported -- which is correct, and which
 * also means the only place the atomicity is observable is the dep itself.
 * Tested there rather than through a pass that swallows the throw on purpose.
 */
describe('the doctor repair writers', () => {
  test('the shape repairer stages and leaves the card intact when that fails', () => {
    const file = join(root, 'card.md')
    writeFileSync(file, `---\ntitle: A\n---\n\n${'body\n'.repeat(200)}`, 'utf8')
    survivesAFailedWrite(file, () => fsShapeRepairDeps().write(file, 'replacement'))
  })

  test('the created: stamper stages and leaves the card intact when that fails', () => {
    const file = join(root, 'card.md')
    writeFileSync(file, `---\ntitle: A\n---\n\n${'body\n'.repeat(200)}`, 'utf8')
    survivesAFailedWrite(file, () => fsStampDeps(NOW).write(file, 'replacement'))
  })
})
