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
import { recordSettledPromises, resetPromiseMemory } from './epic-promise'
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
    overseerAlive: false,
    liveOverseers: [],
    settled: ['t1'],
    failedLegs: [],
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
   * The card names the moment as acknowledgement; acknowledgement fires while
   * the card is still `in-review`, with the verifier's `project_set_status`
   * still to come -- and THAT write flattens a promise block and empties
   * `closes:` (werk-promise-ledger-card-writer-flattens). Writing then would
   * write into a shredder every time.
   */
  test('a settled card still in `in-review` is NOT written -- the verifier has yet to flatten it', async () => {
    commit()
    const out = await recordSettledPromises(deps(), group(), [card('t1', 'in-review')])
    expect(out).toHaveLength(0)
    expect(reads).toBe(0)
    expect(cardFile()).toBe(CARD)
  })

  test('a terminal card that never settled is not touched either', async () => {
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

  test('a recorded card is not read again on the next beat', async () => {
    commit()
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    const before = reads
    await recordSettledPromises(deps(), group(), [card('t1', 'done')])
    expect(reads).toBe(before)
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
   * overseer of the one wake it exists for.
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
