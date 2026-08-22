import { describe, expect, test } from 'bun:test'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { TaskStatus } from '../shared/task-statuses'
import { resolveLandings, wantsFabric } from './epic-landing'
import { cardBranch } from './epic-spawn-plan'
import type { GitDirt } from './epic-types'

const EPIC = 'e1'

function card(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return { slug, status, title: slug, tags: [], refs: [], created: '', mtime: 1, bodyPreview: '', epic: EPIC, ...over }
}

const branchOf = (slug: string) => cardBranch(EPIC, slug)

/** A scan that saw `known` branches, of which `merged` are already in local main. */
const scan = (known: string[], merged: string[] = []): GitDirt => ({
  ok: true,
  dirty: new Set(),
  known: new Set(known),
  merged: new Set(merged),
})

const resolve = (
  cards: ProjectTaskMeta[],
  fabric: GitDirt | null = null,
  target: 'pr' | 'merged' | 'shipped' = 'merged',
) => resolveLandings({ epicId: EPIC, target, fabric }, cards)

describe('resolveLandings', () => {
  test('asks about DONE cards only -- an open card has not claimed to have delivered anything', () => {
    const rows = resolve([card('a', 'done'), card('b', 'open'), card('c', 'in-review')], scan([]))
    expect(rows.map(r => r.cardId)).toEqual(['a'])
  })

  test('`archived` is a decision not to do the work, not undelivered work', () => {
    // Demanding a merge for a card somebody deliberately dropped would freeze a
    // run over a decision it already recorded. `epic-cards.ts` agrees: archived
    // leaves the denominator entirely.
    expect(resolve([card('a', 'archived')], scan([]))).toEqual([])
  })

  test("only THIS epic's children -- a branch that never existed is not worth asking about", () => {
    const rows = resolve([card('mine', 'done'), card('theirs', 'done', { epic: 'other' })], scan([]))
    expect(rows.map(r => r.cardId)).toEqual(['mine'])
  })

  test('a branch main already contains, still a ref, reads STANDING', () => {
    const rows = resolve([card('a', 'done')], scan([branchOf('a')], [branchOf('a')]))
    expect(rows[0]).toMatchObject({ verdict: 'standing', evidence: 'merged' })
  })

  test('a branch ahead of local main reads UNMERGED -- the failure that stranded 34 branches', () => {
    const rows = resolve([card('a', 'done')], scan([branchOf('a')]))
    expect(rows[0]).toMatchObject({ verdict: 'unmerged', evidence: 'ahead' })
  })

  test('a branch the scan never saw reads GONE, and gone is delivered', () => {
    // `worktree-remove.sh` deletes worktree and ref together, fast-forwards
    // first, and refuses while anything is unmerged -- so an absent ref is
    // evidence the cleanup ran and was allowed to.
    expect(resolve([card('a', 'done')], scan(['worktree-epic/e1/other']))[0]).toMatchObject({
      verdict: 'landed',
      evidence: 'gone',
    })
  })

  test('the branch name rides along, because that is what a werk-master needs', () => {
    expect(resolve([card('a', 'done')], scan([branchOf('a')]))[0]?.branch).toBe(branchOf('a'))
  })

  describe('the two ways to have no answer', () => {
    test('no scan bought reads UNSCANNED, which withholds nothing', () => {
      expect(resolve([card('a', 'done')], null)[0]?.verdict).toBe('unknown')
    })

    test('a FAILED scan is the same answer -- never clean, never an accusation', () => {
      expect(resolve([card('a', 'done')], { ok: false, error: 'sentinel timed out' })[0]?.verdict).toBe('unknown')
    })
  })

  test('the run TARGET decides -- the same facts, two answers', () => {
    const cards = [card('a', 'done')]
    const fabric = scan([branchOf('a')])
    expect(resolve(cards, fabric, 'merged')[0]?.verdict).toBe('unmerged')
    expect(resolve(cards, fabric, 'pr')[0]?.verdict).toBe('landed')
  })
})

describe('wantsFabric -- when the scan is worth buying', () => {
  test('not while the epic has no delivery claim to check', () => {
    expect(wantsFabric([card('a', 'open'), card('b', 'in-review')], EPIC)).toBe(false)
  })

  test('yes as soon as one child is done', () => {
    expect(wantsFabric([card('a', 'done'), card('b', 'open')], EPIC)).toBe(true)
  })

  test("another epic's done card does not buy this epic a scan", () => {
    expect(wantsFabric([card('a', 'done', { epic: 'other' })], EPIC)).toBe(false)
  })

  test('an epic with no children buys nothing', () => {
    expect(wantsFabric([], EPIC)).toBe(false)
  })
})
