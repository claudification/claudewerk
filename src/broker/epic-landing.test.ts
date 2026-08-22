import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { CommitRow } from '../shared/commit-ledger'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { TaskStatus } from '../shared/task-statuses'
import { configureEpicIo, resetEpicIo } from './epic-io'
import { resolveLandings, wantsFabric } from './epic-landing'
import { cardBranch } from './epic-spawn-plan'
import type { GitDirt } from './epic-types'

const PROJECT = 'claude://studio/proj'
const EPIC = 'e1'

function card(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return { slug, status, title: slug, tags: [], refs: [], created: '', mtime: 1, bodyPreview: '', epic: EPIC, ...over }
}

const commit = (hash: string): CommitRow => ({ hash }) as CommitRow

/** Branch -> what the ledger found for it. Anything absent is a branch the
 *  ledger has never heard of, which is a real answer and not an error. */
let ledger: Record<string, 'merge' | 'branch'>
let ledgerReady: boolean

beforeEach(() => {
  ledger = {}
  ledgerReady = true
  configureEpicIo({
    commitLedgerReady: () => ledgerReady,
    commitsForBranch: (_project: string, branch: string) => {
      const via = ledger[branch]
      return via ? { via, commits: [commit('abc')] } : null
    },
  })
})

afterEach(() => {
  resetEpicIo()
})

const resolve = (
  cards: ProjectTaskMeta[],
  fabric: GitDirt | null = null,
  target: 'pr' | 'merged' | 'shipped' = 'merged',
) => resolveLandings({ epicId: EPIC, project: PROJECT, target, fabric }, cards)

const branchOf = (slug: string) => cardBranch(EPIC, slug)

describe('resolveLandings', () => {
  test('asks about DONE cards only -- an open card has not claimed to have delivered anything', () => {
    const rows = resolve([card('a', 'done'), card('b', 'open'), card('c', 'in-review')])
    expect(rows.map(r => r.cardId)).toEqual(['a'])
  })

  test('`archived` is a decision not to do the work, not undelivered work', () => {
    // Demanding a merge for a card somebody deliberately dropped would freeze a
    // run over a decision it already recorded. `epic-cards.ts` agrees: archived
    // leaves the denominator entirely.
    expect(resolve([card('a', 'archived')])).toEqual([])
  })

  test("only THIS epic's children -- a branch that never existed is not a fact worth asking for", () => {
    expect(resolve([card('mine', 'done'), card('theirs', 'done', { epic: 'other' })]).map(r => r.cardId)).toEqual([
      'mine',
    ])
  })

  test('a merge commit on the trunk reads LANDED', () => {
    ledger[branchOf('a')] = 'merge'
    expect(resolve([card('a', 'done')])[0]).toMatchObject({ verdict: 'landed', evidence: 'merged' })
  })

  test('commits on the branch alone read UNMERGED -- the failure that stranded 34 branches', () => {
    ledger[branchOf('a')] = 'branch'
    expect(resolve([card('a', 'done')])[0]).toMatchObject({ verdict: 'unmerged', evidence: 'committed' })
  })

  test('the branch name rides along, because that is what a werk-master needs', () => {
    ledger[branchOf('a')] = 'branch'
    expect(resolve([card('a', 'done')])[0]?.branch).toBe(branchOf('a'))
  })

  test('no commit ledger open means UNKNOWN for everything -- a missing db freezes no epic', () => {
    ledgerReady = false
    ledger[branchOf('a')] = 'branch'
    expect(resolve([card('a', 'done')])[0]?.verdict).toBe('unknown')
  })

  test('the run TARGET decides -- the same facts, two answers', () => {
    ledger[branchOf('a')] = 'branch'
    expect(resolve([card('a', 'done')], null, 'merged')[0]?.verdict).toBe('unmerged')
    expect(resolve([card('a', 'done')], null, 'pr')[0]?.verdict).toBe('landed')
  })

  describe('the git fabric half', () => {
    const standing = (branches: string[]): GitDirt => ({
      ok: true,
      dirty: new Set(),
      known: new Set(branches),
    })

    test('a merged branch whose worktree is still there reads STANDING', () => {
      ledger[branchOf('a')] = 'merge'
      expect(resolve([card('a', 'done')], standing([branchOf('a')]))[0]?.verdict).toBe('standing')
    })

    test('a merged branch the scan did not see reads LANDED', () => {
      ledger[branchOf('a')] = 'merge'
      expect(resolve([card('a', 'done')], standing(['worktree-epic/e1/somebody-else']))[0]?.verdict).toBe('landed')
    })

    test('a FAILED scan is the same answer as no scan at all -- unknown, never clean', () => {
      // "We could not look" must not read as "there is nothing there". The
      // verdict falls back to the ledger's half alone.
      ledger[branchOf('a')] = 'merge'
      expect(resolve([card('a', 'done')], { ok: false, error: 'sentinel timed out' })[0]?.verdict).toBe('landed')
    })
  })
})

describe('wantsFabric -- when the 15-second round trip is worth buying', () => {
  test('not while anything is already unmerged: the escalation goes out regardless', () => {
    ledger[branchOf('a')] = 'branch'
    const cards = [card('a', 'done')]
    expect(wantsFabric(cards, EPIC, resolve(cards))).toBe(false)
  })

  test('not while work is still moving -- a healthy mid-flight beat pays nothing', () => {
    ledger[branchOf('a')] = 'merge'
    const cards = [card('a', 'done'), card('b', 'open')]
    expect(wantsFabric(cards, EPIC, resolve(cards))).toBe(false)
  })

  test('YES on the beat that would otherwise flip the run to complete', () => {
    ledger[branchOf('a')] = 'merge'
    ledger[branchOf('b')] = 'merge'
    const cards = [card('a', 'done'), card('b', 'done')]
    expect(wantsFabric(cards, EPIC, resolve(cards))).toBe(true)
  })

  test('archived children do not keep it from firing', () => {
    ledger[branchOf('a')] = 'merge'
    const cards = [card('a', 'done'), card('b', 'archived')]
    expect(wantsFabric(cards, EPIC, resolve(cards))).toBe(true)
  })

  test('an epic with no children buys nothing', () => {
    expect(wantsFabric([], EPIC, [])).toBe(false)
  })
})
