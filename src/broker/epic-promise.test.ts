import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommitIngestPayload } from '../shared/commit-ledger'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import { parsePromiseBlock } from '../shared/promise-ledger'
import type { EpicLogAppendInput, EpicResult, ProjectReadFileResult } from '../shared/protocol'
import type { TaskStatus } from '../shared/task-statuses'
import { commitsForBranch } from './commit-ledger/branch'
import { normalizeCommit } from './commit-ledger/normalize'
import { closeCommitLedger, initCommitLedger, insertCommit } from './commit-ledger/store'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { recordFinalPromises, recordSettledPromises, resetPromiseMemory } from './epic-promise'
import type { EpicGroup } from './epic-sweep'
import type { BeatDeps } from './epic-types'

const PROJECT = 'claude://studio/Users/x/proj'
const WORKTREE = 'claude://studio/Users/x/proj/.claude/worktrees/epic/e1/t1'
const EPIC = 'e1'
/** What `cardBranch('e1', 't1')` resolves to. Spelled out rather than imported
 *  so a change to the branch shape fails a test that says what it broke. */
const BRANCH = 'worktree-epic/e1/t1'

const NOW = Date.parse('2026-08-21T12:00:00.000Z')

const CARD = ['---', 'title: "A settled card"', 'status: done', 'epic: e1', '---', '', 'Body.', ''].join('\n')

let dir: string
let files: Map<string, string>
let baton: EpicLogAppendInput[]
let log: string[]
let reads: number
let writes: number
/** Overridable read result -- the failure paths need a read that does not read. */
let readOverride: ProjectReadFileResult | null

function card(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status,
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-19T00:00:00.000Z',
    mtime: 1,
    bodyPreview: '',
    ...over,
  }
}

function group(over: Partial<EpicGroup> = {}): EpicGroup {
  return {
    epicId: EPIC,
    project: PROJECT,
    inFlight: [],
    inVerify: [],
    werkMasterAlive: false,
    liveWerkMasters: [],
    abandonedWerkMasters: [],
    settled: ['t1'],
    failedLegs: [],
    abandonedSeats: [],
    unspawnable: [],
    convIds: [],
    maxGenSeen: 1,
    ...over,
  }
}

const deps = () =>
  ({
    getSentinel: () => undefined,
    getSentinelByAlias: () => undefined,
    addProjectListener: () => {},
    removeProjectListener: () => {},
    spawnContext: {},
    log: (line: string) => log.push(line),
    windowOpen: async () => true,
    now: () => NOW,
    epicSpendUsd: () => 0,
  }) as unknown as BeatDeps

/** One commit into the real ledger -- the resolver is the thing under test here,
 *  so it is NOT stubbed. */
function commit(over: Partial<CommitIngestPayload> = {}) {
  return insertCommit(
    normalizeCommit(
      {
        hash: 'a'.repeat(40),
        parents: 'b'.repeat(40),
        repoUri: PROJECT,
        cwdUri: WORKTREE,
        // The default is a WORKTREE commit, because a card's branch only ever
        // lives in one. `repoUri` staying the main root is what the real hook
        // sends (scripts/git-hooks/post-commit).
        isWorktree: true,
        branch: BRANCH,
        subject: 'feat(t1): the work',
        files: [{ status: 'M', path: 'src/x.ts' }],
        committedAt: NOW - 60_000,
        conversationId: 'conv_impl',
        conversationName: 'werk-t1',
        ...over,
      },
      NOW,
    ),
    null,
  )
}

const cardFile = () => files.get('.rclaude/project/cards/t1.md') ?? ''
const closesOf = (text: string) => parsePromiseBlock(text)?.closes ?? []
const records = () => baton.filter(e => e.kind === 'record')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epic-promise-test-'))
  initCommitLedger(dir)
  resetPromiseMemory()
  files = new Map([['.rclaude/project/cards/t1.md', CARD]])
  baton = []
  log = []
  reads = 0
  writes = 0
  readOverride = null

  configureEpicIo({
    appendBaton: async (_d, _p, _e, entry) => {
      baton.push(entry)
      return { type: 'epic_result', requestId: 'r', op: 'log_append', ok: true } as EpicResult
    },
    readProjectFile: async (_d, _p, relPath) => {
      reads += 1
      if (readOverride) return readOverride
      const content = files.get(relPath)
      return content === undefined
        ? { type: 'project_read_file_result', requestId: 'r', ok: false, error: 'ENOENT' }
        : { type: 'project_read_file_result', requestId: 'r', ok: true, content, size: content.length }
    },
    writeProjectFile: async (_d, _p, relPath, content) => {
      writes += 1
      files.set(relPath, content)
      return { type: 'project_write_file_result', requestId: 'r', ok: true, size: content.length }
    },
    // The real resolver over the real (temp) ledger.
    commitsForBranch,
  })
})

afterEach(() => {
  resetEpicIo()
  closeCommitLedger()
  rmSync(dir, { recursive: true, force: true })
})

describe('recordSettledPromises -- who writes `closes:`, and when', () => {
  test('a settled TERMINAL card gets the branch commit written into its `closes:`', async () => {
    commit()
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ cardId: 't1', branch: BRANCH, via: 'branch', refused: null })
    expect(out[0].added).toEqual(['a'.repeat(40)])
    expect(closesOf(cardFile())).toEqual(['a'.repeat(40)])
  })

  /**
   * The merge is what makes a promise `delivered` rather than merely committed,
   * so it OUTRANKS the branch's own commits -- and it is one sha, not ten.
   */
  test('a merge commit on the trunk beats the branch commits', async () => {
    commit()
    commit({
      hash: 'c'.repeat(40),
      cwdUri: PROJECT,
      isWorktree: false,
      branch: 'main',
      subject: `Merge branch '${BRANCH}'`,
      committedAt: NOW - 10_000,
    })

    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(out[0].via).toBe('merge')
    expect(closesOf(cardFile())).toEqual(['c'.repeat(40)])
  })

  /**
   * THE GATE IS `settled`, AND NOTHING ELSE. This test used to assert the exact
   * opposite -- that an `in-review` card was skipped -- because the werk-verifier's
   * `project_set_status` went on to flatten a nested promise block and empty
   * `closes:`. That writer bug is fixed on main (`2ba978d0`), so the lane gate
   * lost its reason, and it is inverted here rather than deleted: the pairing is
   * the record of why the answer changed.
   *
   * Acknowledgement IS the moment. A card settles when its werk-worker ends, at
   * which point the sha exists and no verdict is needed to know it.
   */
  test('a settled card in `in-review` IS written -- acknowledgement is the moment', async () => {
    commit()
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'in-review')])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ cardId: 't1', via: 'branch', refused: null })
    expect(closesOf(cardFile())).toEqual(['a'.repeat(40)])
  })

  test('a terminal card that never settled is not touched by the per-beat pass', async () => {
    commit()
    const out = await recordSettledPromises(deps(), group({ settled: [] }), [card('t1', 'done')])
    expect(out).toHaveLength(0)
    expect(writes).toBe(0)
  })

  /**
   * THE HIGHEST-VALUE REFUSAL IN THE FILE. `could not verify` is never folded
   * into `delivered`, and a guessed sha is not a verdict.
   */
  test('no commit for the branch writes NOTHING and says so', async () => {
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out[0]).toMatchObject({ added: [], via: null, retryable: true })
    expect(out[0].refused).toContain('no commit on')
    expect(cardFile()).toBe(CARD)
    expect(records()[0].body).toContain('PROMISE NOT RECORDED')
  })

  test('an unresolvable card is retried on a later beat, and lands once the commit exists', async () => {
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    commit()
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out[0].refused).toBeNull()
    expect(closesOf(cardFile())).toEqual(['a'.repeat(40)])
  })

  test('the same refusal is said ONCE, however many beats ask', async () => {
    for (let i = 0; i < 3; i += 1) await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(records()).toHaveLength(1)
  })

  test('a recorded TERMINAL card is not read again on the next beat', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    const before = reads
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(reads).toBe(before)
  })

  /**
   * THE BOUNCE. A werk-verifier can send a card back to `open`, a second werk-worker
   * picks it up and commits more, and the card settles a second time. Retiring
   * it on the first settle would freeze `closes:` at round one's shas -- which
   * is the regression that dropping the lane gate would otherwise have
   * introduced, since a non-terminal card now gets recorded at all.
   */
  test('a card that is settled but NOT terminal stays askable, and picks up round two', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'in-review')])
    expect(closesOf(cardFile())).toEqual(['a'.repeat(40)])

    // Bounced to `open`, a second werk-worker commits, it settles again.
    commit({ hash: 'b'.repeat(40), subject: 'fix(t1): the bounce, paid', committedAt: NOW - 1_000 })
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'open')])

    expect(out[0].added).toEqual(['b'.repeat(40)])
    expect(closesOf(cardFile())).toEqual(['a'.repeat(40), 'b'.repeat(40)])
  })

  /** Re-asking has to be SILENT or a long run buries its own baton: one line
   *  every 45 seconds saying "nothing to add" is worse than no line. */
  test('a re-ask that adds nothing says nothing', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'in-review')])
    expect(records()).toHaveLength(1)

    await recordSettledPromises(deps(), group(), [card('t1', 'in-review')])
    expect(records()).toHaveLength(1)
  })

  /** The memory is a CACHE over an idempotent write, so losing it costs a read
   *  and never a duplicated sha. */
  test('forgetting the memory re-reads the card and adds nothing', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    const writesAfterFirst = writes

    resetPromiseMemory()
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out[0].added).toEqual([])
    expect(out[0].refused).toBeNull()
    expect(writes).toBe(writesAfterFirst)
    expect(closesOf(cardFile())).toEqual(['a'.repeat(40)])
  })

  test('the commit that did the work is recorded as the recoverable conversation', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(parsePromiseBlock(cardFile())?.conversation).toBe('werk-t1')
  })

  /** The hook interpolates `${CLAUDWERK_CONVERSATION_NAME:-}`, so an unset name
   *  arrives as an EMPTY STRING and `??` would happily record `""`. */
  test('an unnamed conversation falls through to the conversation id, not to blank', async () => {
    commit({ conversationName: '' })
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(parsePromiseBlock(cardFile())?.conversation).toBe('conv_impl')
  })

  test('`asked:` is scaffolded EMPTY -- a plausible fake ask is worse than a blank', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(cardFile()).toContain('  asked: ""')
    expect(parsePromiseBlock(cardFile())?.asked).toBeNull()
  })

  test('`agreed:` comes from the card, not from the clock', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(parsePromiseBlock(cardFile())?.agreed).toBe('2026-08-19')
  })

  /** Line surgery, not a re-serialisation: every byte outside the block stands. */
  test('the rest of the card is left byte-identical', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    const after = cardFile()
    expect(after).toContain('---\ntitle: "A settled card"\nstatus: done\nepic: e1\npromise:\n')
    expect(after.endsWith('---\n\nBody.\n')).toBe(true)
  })

  test('the commit subject rides along as a comment, so `closes:` reads as history', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(cardFile()).toContain('# feat(t1): the work')
  })
})

describe('recordSettledPromises -- it never blocks and never guesses', () => {
  test('a card that cannot be read is refused, RETRYABLY, and nothing throws', async () => {
    commit()
    readOverride = { type: 'project_read_file_result', requestId: 'r', ok: false, error: 'sentinel timed out' }
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out[0]).toMatchObject({ retryable: true, added: [] })
    expect(out[0].refused).toContain('could not read the card')
    expect(writes).toBe(0)
  })

  /**
   * A TRUNCATED READ WRITTEN BACK DELETES THE TAIL OF THE CARD. Final, not
   * retried: the card is not going to shrink on its own.
   */
  test('a truncated read is never written back', async () => {
    commit()
    readOverride = {
      type: 'project_read_file_result',
      requestId: 'r',
      ok: true,
      content: CARD.slice(0, 20),
      truncated: true,
    }
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out[0].refused).toContain('larger than')
    expect(out[0].retryable).toBe(false)
    expect(writes).toBe(0)
  })

  /**
   * MIXED LINE ENDINGS. `insertPromiseBlock` and `appendCloses` refuse a card
   * whose EOLs disagree rather than mangling the half they did not pick
   * (`werk-promise-ledger-crlf-write-mangles`, landed on main after this feature
   * was first cut). That refusal has to arrive here as a CLASSIFIED refusal with
   * a reason in the baton -- a writer that returns `refused` and a caller that
   * treats it as a no-op is a card silently losing its receipt.
   */
  test('a card with mixed CRLF and LF is refused with the reason, never rewritten', async () => {
    commit()
    const mangled = '---\r\ntitle: "A settled card"\nstatus: done\r\nepic: e1\r\n---\r\n\r\nBody.\r\n'
    files.set('.rclaude/project/cards/t1.md', mangled)
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out[0].refused).toContain('CRLF')
    // FINAL, not retryable: a card's line endings do not fix themselves, and
    // asking again every 45 seconds for the rest of the run buys nothing.
    expect(out[0].retryable).toBe(false)
    expect(cardFile()).toBe(mangled)
    expect(writes).toBe(0)
    expect(records()[0].body).toContain('PROMISE NOT RECORDED')
  })

  test('a card with no front matter is left ALONE with the reason logged', async () => {
    commit()
    files.set('.rclaude/project/cards/t1.md', 'no front matter here\n')
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out[0].refused).toContain('no front matter')
    expect(cardFile()).toBe('no front matter here\n')
    expect(log.some(l => l.includes('promise NOT recorded'))).toBe(true)
  })

  test('a permanent refusal is not retried', async () => {
    commit()
    files.set('.rclaude/project/cards/t1.md', 'no front matter here\n')
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(out).toHaveLength(0)
  })

  /**
   * `completion` is what `acknowledgedCardIds` folds. A promise entry wearing
   * that kind would acknowledge a settle nobody had acknowledged and rob the
   * werk-master of the one wake it exists for.
   */
  test('every entry it writes is a `record` -- it acknowledges NOTHING', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(baton).toHaveLength(1)
    expect(baton[0]).toMatchObject({ kind: 'record', convId: 'broker', cardId: 't1' })
  })

  test('a baton append that fails does not take the pass down', async () => {
    commit()
    configureEpicIo({
      appendBaton: async () =>
        ({ type: 'epic_result', requestId: 'r', op: 'log_append', ok: false, error: 'no sentinel' }) as EpicResult,
    })
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])

    expect(out[0].refused).toBeNull()
    expect(closesOf(cardFile())).toEqual(['a'.repeat(40)])
    expect(log.some(l => l.includes('promise record append FAILED'))).toBe(true)
  })

  test('a ledger that was never initialised resolves nothing rather than throwing', async () => {
    closeCommitLedger()
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(out[0].refused).toContain('no commit on')
    initCommitLedger(dir)
  })
})

/**
 * LAST CALL -- the pass that exists because the per-beat one can run out of
 * beats. A run completes off card LANES alone, so the last child's werk-verifier can
 * still be alive on the beat that ends the run: the card is not settled, the
 * pass above skips it, and every later beat returns at `isInertRun` before a
 * card is read. Reported as F1 against the first cut of this feature.
 */
describe('recordFinalPromises -- the beat that ends the run', () => {
  test('records a TERMINAL card that never settled -- there is no next beat', async () => {
    commit()
    const out = await recordFinalPromises(deps(), group({ settled: [] }), [card('t1', 'done')])

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ cardId: 't1', refused: null })
    expect(closesOf(cardFile())).toEqual(['a'.repeat(40)])
  })

  /** The lane is the ONLY evidence at last call, so it has to be asked. A card
   *  still being worked is not finished, and a promise is a claim about
   *  finished work -- a park with children in flight must not invent one. */
  test('a card that is not terminal gets nothing, even at last call', async () => {
    commit()
    const out = await recordFinalPromises(deps(), group({ settled: [] }), [card('t1', 'in-progress')])

    expect(out).toHaveLength(0)
    expect(reads).toBe(0)
    expect(cardFile()).toBe(CARD)
  })

  test('a card already recorded this run is skipped, not written twice', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    const writesAfterFirst = writes
    const out = await recordFinalPromises(deps(), group(), [card('t1', 'done')])

    expect(out).toHaveLength(0)
    expect(writes).toBe(writesAfterFirst)
  })

  /** "We will ask again next beat" is a lie at last call -- there is no next
   *  beat. The refusal is said even if a softer version was said earlier. */
  test('a refusal that WAS retryable is announced again, as FINAL', async () => {
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(records()).toHaveLength(1)

    const out = await recordFinalPromises(deps(), group({ settled: [] }), [card('t1', 'done')])

    expect(out[0].refused).toContain('no commit on')
    expect(records()).toHaveLength(2)
    expect(records()[1].body).toContain('this is FINAL')
  })
})

describe('commitsForBranch', () => {
  test('a `_` in a card id is not a LIKE wildcard', async () => {
    commit({
      hash: 'd'.repeat(40),
      cwdUri: PROJECT,
      isWorktree: false,
      branch: 'main',
      subject: "Merge branch 'worktree-epic/e1/t-1'",
    })
    // `t_1` would match `t-1` if the underscore reached LIKE unescaped, and the
    // ledger would file one card's merge against another card's promise.
    expect(commitsForBranch(PROJECT, 'worktree-epic/e1/t_1')).toBeNull()
  })

  test('a merge performed INSIDE a worktree is a seat integrating, not delivery', async () => {
    commit({
      hash: 'e'.repeat(40),
      cwdUri: WORKTREE,
      isWorktree: true,
      branch: 'worktree-epic/e1/t2',
      subject: `Merge branch '${BRANCH}'`,
    })
    expect(commitsForBranch(PROJECT, BRANCH)).toBeNull()
  })

  test('commits from another project are never borrowed', async () => {
    commit({ repoUri: 'claude://studio/Users/x/other', cwdUri: 'claude://studio/Users/x/other' })
    expect(commitsForBranch(PROJECT, BRANCH)).toBeNull()
  })

  test('branch commits come back oldest first', async () => {
    commit({ hash: '1'.repeat(40), committedAt: NOW - 3_000 })
    commit({ hash: '2'.repeat(40), committedAt: NOW - 2_000 })
    expect(commitsForBranch(PROJECT, BRANCH)?.commits.map(c => c.hash)).toEqual(['1'.repeat(40), '2'.repeat(40)])
  })
})
