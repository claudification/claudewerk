import { describe, expect, it } from 'vitest'
import { parseProjectCardPath } from './project-card-link'

describe('parseProjectCardPath', () => {
  it('matches a board card path', () => {
    expect(parseProjectCardPath('.rclaude/project/open/fix-the-thing.md')).toEqual({
      status: 'open',
      slug: 'fix-the-thing',
    })
  })

  it('matches every status lane', () => {
    for (const status of ['inbox', 'open', 'in-progress', 'in-review', 'done', 'archived'] as const) {
      expect(parseProjectCardPath(`.rclaude/project/${status}/x.md`)?.status).toBe(status)
    }
  })

  it('tolerates a ./ or repo-path prefix', () => {
    expect(parseProjectCardPath('./.rclaude/project/inbox/a.md')?.slug).toBe('a')
    expect(parseProjectCardPath('sub/dir/.rclaude/project/inbox/a.md')?.slug).toBe('a')
  })

  it('strips a hash or query suffix', () => {
    expect(parseProjectCardPath('.rclaude/project/done/a.md#notes')?.slug).toBe('a')
    expect(parseProjectCardPath('.rclaude/project/done/a.md?v=2')?.slug).toBe('a')
  })

  it('rejects plain files, other dirs, and bogus lanes', () => {
    expect(parseProjectCardPath('docs/ops.md')).toBeNull()
    expect(parseProjectCardPath('.rclaude/docs/plan-fabric.md')).toBeNull()
    expect(parseProjectCardPath('.rclaude/project/nope/a.md')).toBeNull()
    expect(parseProjectCardPath('.rclaude/project/open/a.txt')).toBeNull()
    expect(parseProjectCardPath('.rclaude/project/open/')).toBeNull()
    expect(parseProjectCardPath('')).toBeNull()
  })

  it('does not match the lane folder itself', () => {
    expect(parseProjectCardPath('.rclaude/project/open/nested/a.md')).toBeNull()
  })
})
