/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { parseProjectCardPath } from './project-card-link'

describe('parseProjectCardPath', () => {
  it('matches the canonical card path', () => {
    expect(parseProjectCardPath('.rclaude/project/cards/fix-the-thing.md')).toEqual({ id: 'fix-the-thing' })
  })

  it('still matches every legacy status lane -- old links must never rot', () => {
    for (const status of ['inbox', 'open', 'in-progress', 'in-review', 'done', 'archived'] as const) {
      expect(parseProjectCardPath(`.rclaude/project/${status}/x.md`)).toEqual({ id: 'x' })
    }
  })

  it('matches a generated view symlink', () => {
    expect(parseProjectCardPath('.rclaude/project/views/in-review/x.md')).toEqual({ id: 'x' })
  })

  it('tolerates a ./ or repo-path prefix', () => {
    expect(parseProjectCardPath('./.rclaude/project/inbox/a.md')?.id).toBe('a')
    expect(parseProjectCardPath('sub/dir/.rclaude/project/cards/a.md')?.id).toBe('a')
  })

  it('strips a hash or query suffix', () => {
    expect(parseProjectCardPath('.rclaude/project/done/a.md#notes')?.id).toBe('a')
    expect(parseProjectCardPath('.rclaude/project/cards/a.md?v=2')?.id).toBe('a')
  })

  it('rejects plain files, other dirs, and bogus lanes', () => {
    expect(parseProjectCardPath('docs/ops.md')).toBeNull()
    expect(parseProjectCardPath('.rclaude/docs/plan-fabric.md')).toBeNull()
    expect(parseProjectCardPath('.rclaude/project/nope/a.md')).toBeNull()
    expect(parseProjectCardPath('.rclaude/project/priority.md')).toBeNull()
    expect(parseProjectCardPath('.rclaude/project/cards/a.txt')).toBeNull()
    expect(parseProjectCardPath('.rclaude/project/cards/')).toBeNull()
    expect(parseProjectCardPath('')).toBeNull()
  })

  it('does not match a nested path under the card dir', () => {
    expect(parseProjectCardPath('.rclaude/project/cards/nested/a.md')).toBeNull()
    expect(parseProjectCardPath('.rclaude/project/open/nested/a.md')).toBeNull()
  })
})
