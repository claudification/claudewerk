import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProjectTask,
  deleteProjectTask,
  getProjectTask,
  listProjectManifest,
  listProjectTasks,
  moveProjectFile,
  ProjectPathError,
  readProjectFile,
  resolveInRoot,
  setProjectTaskStatus,
  updateProjectTask,
  writeProjectFile,
} from './project-store'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-store-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveInRoot (path jail)', () => {
  test('resolves an in-root relative path', () => {
    expect(resolveInRoot(root, 'docs/hello.md')).toBe(join(root, 'docs/hello.md'))
  })
  test('strips a leading slash and treats input as project-relative', () => {
    expect(resolveInRoot(root, '/docs/hello.md')).toBe(join(root, 'docs/hello.md'))
  })
  test('rejects ../ traversal', () => {
    expect(() => resolveInRoot(root, '../escape.md')).toThrow(ProjectPathError)
  })
  test('rejects deep ../ traversal back into root-sibling', () => {
    expect(() => resolveInRoot(root, 'docs/../../escape.md')).toThrow(ProjectPathError)
  })
  test('rejects null bytes', () => {
    expect(() => resolveInRoot(root, 'docs/\0.md')).toThrow(ProjectPathError)
  })
  test('rejects empty path', () => {
    expect(() => resolveInRoot(root, '')).toThrow(ProjectPathError)
  })
})

describe('raw file I/O', () => {
  test('write then read round-trips', () => {
    expect(writeProjectFile(root, 'docs/note.md', '# Hi\nbody').ok).toBe(true)
    const r = readProjectFile(root, 'docs/note.md')
    expect(r.ok).toBe(true)
    expect(r.content).toBe('# Hi\nbody')
  })
  test('read rejects an escaping path', () => {
    const r = readProjectFile(root, '../../etc/passwd')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('escapes project root')
  })
  test('read of a missing file fails gracefully', () => {
    const r = readProjectFile(root, 'nope.md')
    expect(r.ok).toBe(false)
  })
  test('read truncates beyond the byte cap', () => {
    writeProjectFile(root, 'big.md', 'x'.repeat(100))
    const r = readProjectFile(root, 'big.md', 10)
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.content?.length).toBe(10)
    expect(r.size).toBe(100)
  })
  test('move relocates a file, both ends jailed', () => {
    writeProjectFile(root, 'a.md', 'data')
    expect(moveProjectFile(root, 'a.md', 'sub/b.md').ok).toBe(true)
    expect(existsSync(join(root, 'a.md'))).toBe(false)
    expect(readProjectFile(root, 'sub/b.md').content).toBe('data')
  })
  test('move rejects an escaping destination', () => {
    writeProjectFile(root, 'a.md', 'data')
    expect(moveProjectFile(root, 'a.md', '../b.md').ok).toBe(false)
  })
})

describe('board CRUD', () => {
  test('create -> list/manifest -> get -> update -> set status -> delete', () => {
    const created = createProjectTask(root, { title: 'Build the thing', body: 'do it', priority: 'high' }, 1000)
    expect(created.status).toBe('inbox')
    expect(created.slug).toBe('build-the-thing')

    const manifest = listProjectManifest(root)
    expect(manifest.find(m => m.slug === 'build-the-thing')?.status).toBe('inbox')

    const list = listProjectTasks(root)
    expect(list.some(t => t.slug === 'build-the-thing')).toBe(true)

    const got = getProjectTask(root, 'build-the-thing')
    expect(got?.title).toBe('Build the thing')
    expect(got?.body).toBe('do it')

    const updated = updateProjectTask(root, 'build-the-thing', { body: 'changed' })
    expect(updated?.body).toBe('changed')
    expect(updated?.title).toBe('Build the thing') // preserved

    expect(setProjectTaskStatus(root, 'build-the-thing', 'in-progress', 2000)).toBe('inbox')
    expect(getProjectTask(root, 'build-the-thing')?.status).toBe('in-progress')
    expect(getProjectTask(root, 'build-the-thing')?.body).toBe('changed')

    expect(deleteProjectTask(root, 'build-the-thing')).toBe(true)
    expect(getProjectTask(root, 'build-the-thing')).toBeNull()
  })

  test('dedup gives a second same-titled task a distinct slug', () => {
    createProjectTask(root, { title: 'dup', body: 'a' }, 1000)
    const second = createProjectTask(root, { title: 'dup', body: 'b' }, 1001)
    expect(second.slug).toBe('dup-2')
  })

  test('create dedups against an undrained legacy lane card', () => {
    mkdirSync(join(root, '.rclaude/project/done'), { recursive: true })
    writeFileSync(join(root, '.rclaude/project/done/x.md'), '---\ntitle: x\n---\n')
    expect(createProjectTask(root, { title: 'x', body: '' }, 1000).slug).toBe('x-2')
  })

  test('setProjectTaskStatus on a missing card returns null', () => {
    expect(setProjectTaskStatus(root, 'ghost', 'done', 1000)).toBeNull()
  })
})
