import { beforeEach, describe, expect, it } from 'bun:test'
import type { ToolContext } from './tool-def'
import { buildWorkspaceToolset, listFiles, readFile, resetAllWorkspaces, resetWorkspace, writeFile } from './workspace'

const ctx: ToolContext = {}

beforeEach(() => resetAllWorkspaces())

describe('workspace VFS', () => {
  it('writes, reads, and lists files in a named workspace', () => {
    writeFile('plan', 'notes.md', 'hello')
    writeFile('plan', 'todo.md', 'do it')
    expect(readFile('plan', 'notes.md')).toBe('hello')
    expect(listFiles('plan')).toEqual(['notes.md', 'todo.md'])
  })

  it('isolates workspaces and resets one independently', () => {
    writeFile('a', 'f', '1')
    writeFile('b', 'f', '2')
    expect(resetWorkspace('a')).toEqual({ workspace: 'a', cleared: 1 })
    expect(listFiles('a')).toEqual([])
    expect(readFile('b', 'f')).toBe('2')
  })

  it('throws reading a missing file', () => {
    expect(() => readFile('x', 'nope')).toThrow(/no file/)
  })

  it('caps file size', () => {
    expect(() => writeFile('x', 'big', 'z'.repeat(64 * 1024 + 1))).toThrow(/too large/)
  })

  it('exposes the tools defaulting to the default workspace', async () => {
    const ts = buildWorkspaceToolset()
    await ts.workspace_write.execute({ workspace: null, path: 'a.txt', content: 'hi' }, ctx)
    expect(await ts.workspace_read.execute({ workspace: null, path: 'a.txt' }, ctx)).toBe('hi')
    expect(await ts.workspace_list.execute({ workspace: null }, ctx)).toEqual(['a.txt'])
    expect(await ts.reset_workspace.execute({ workspace: null }, ctx)).toEqual({ workspace: 'default', cleared: 1 })
  })
})
