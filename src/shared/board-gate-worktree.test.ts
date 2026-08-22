import { describe, expect, it } from 'bun:test'
import { parseWorktreeList, resolveGateCwd } from './board-gate-worktree'

const ROOT = '/repo'
const wt = (name: string) => `${ROOT}/.claude/worktrees/${name}`

const PORCELAIN = [
  `worktree ${ROOT}`,
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  `worktree ${wt('epic/epic-x/my-card')}`,
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/worktree-epic/epic-x/my-card',
  '',
  `worktree ${wt('verify-my-card')}`,
  'HEAD 3333333333333333333333333333333333333333',
  'branch refs/heads/worktree-epic/epic-x/verify-my-card',
  '',
  'worktree /private/tmp/guard-base',
  'HEAD 4444444444444444444444444444444444444444',
  'detached',
  '',
].join('\n')

describe('parseWorktreeList', () => {
  it('reads path + branch, strips refs/heads/', () => {
    const list = parseWorktreeList(PORCELAIN)
    expect(list).toHaveLength(4)
    expect(list[0]).toEqual({ path: ROOT, branch: 'main' })
    expect(list[1]).toEqual({ path: wt('epic/epic-x/my-card'), branch: 'worktree-epic/epic-x/my-card' })
  })

  it('leaves a detached worktree without a branch', () => {
    expect(parseWorktreeList(PORCELAIN)[3]).toEqual({ path: '/private/tmp/guard-base' })
  })

  it('survives empty output', () => {
    expect(parseWorktreeList('')).toEqual([])
  })
})

describe('resolveGateCwd', () => {
  const list = parseWorktreeList(PORCELAIN)

  it("picks the worktree whose last path segment IS the card id -- not the werk-verifier's", () => {
    expect(resolveGateCwd(ROOT, 'my-card', list)).toEqual({
      cwd: wt('epic/epic-x/my-card'),
      note: 'worktree',
    })
  })

  it('resolves a werk-verifier worktree by its own id when that is the card', () => {
    expect(resolveGateCwd(ROOT, 'verify-my-card', list).cwd).toBe(wt('verify-my-card'))
  })

  it('falls back to the project root when no worktree carries the card id', () => {
    expect(resolveGateCwd(ROOT, 'never-worked-on', list)).toEqual({ cwd: ROOT, note: 'no-worktree' })
  })

  it('never matches a worktree outside <root>/.claude/worktrees', () => {
    const outside = parseWorktreeList([`worktree ${ROOT}`, '', 'worktree /private/tmp/scratch/my-card', ''].join('\n'))
    expect(resolveGateCwd(ROOT, 'my-card', outside)).toEqual({ cwd: ROOT, note: 'no-worktree' })
  })

  it('refuses to guess when two worktrees share the card id', () => {
    const ambiguous = parseWorktreeList(
      [`worktree ${ROOT}`, '', `worktree ${wt('my-card')}`, '', `worktree ${wt('epic/e/my-card')}`, ''].join('\n'),
    )
    expect(resolveGateCwd(ROOT, 'my-card', ambiguous)).toEqual({ cwd: ROOT, note: 'ambiguous' })
  })

  it('does not match on a partial segment', () => {
    expect(resolveGateCwd(ROOT, 'card', list).cwd).toBe(ROOT)
  })

  it('an empty card id resolves to the root rather than matching anything', () => {
    expect(resolveGateCwd(ROOT, '', list)).toEqual({ cwd: ROOT, note: 'no-worktree' })
  })
})
