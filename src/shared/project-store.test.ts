import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { detectCardDefects, parsePromiseBlock } from './promise-ledger'

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

/**
 * THE TRAP THIS EXISTS TO CATCH: a key declared on `ProjectTaskInput` and
 * nowhere else is accepted by the type and silently dropped on write. `epic`,
 * `dependsOn` and `relatesTo` all went out that way through `createTask` until
 * 2026-08-21, and the morning report's `apply` op would have hit it again --
 * reporting success while archiving cards with no record of why.
 *
 * So each of the three is driven all the way to disk and back, not asserted
 * against the projected object the writer happened to return.
 */
describe('the lifecycle keys survive a round trip', () => {
  const LIFECYCLE = {
    archivedReason: 'duplicate-of:the-survivor',
    archivedBy: 'report-2026-08-22',
    deleteAt: '2026-09-30T00:00:00Z',
  }

  test('createProjectTask writes all three', () => {
    createProjectTask(root, { title: 'Archived thing', body: 'b', status: 'archived', ...LIFECYCLE }, 1000)

    const got = getProjectTask(root, 'archived-thing')
    expect(got?.archivedReason).toBe('duplicate-of:the-survivor')
    expect(got?.archivedBy).toBe('report-2026-08-22')
    expect(got?.deleteAt).toBe('2026-09-30T00:00:00Z')
  })

  test('updateProjectTask adds them to a card that never carried them', () => {
    createProjectTask(root, { title: 'Cold card', body: 'b' }, 1000)
    const updated = updateProjectTask(root, 'cold-card', {
      status: 'archived',
      archivedReason: 'cold',
      archivedBy: 'me',
    })

    expect(updated?.archivedReason).toBe('cold')
    expect(readFileSync(join(root, '.rclaude/project/cards/cold-card.md'), 'utf8')).toContain('archived_reason: cold')
    expect(getProjectTask(root, 'cold-card')?.archivedBy).toBe('me')
  })

  test('a patch that does not mention them leaves them alone', () => {
    createProjectTask(root, { title: 'Kept', body: 'b', status: 'archived', ...LIFECYCLE }, 1000)
    updateProjectTask(root, 'kept', { priority: 'high' })

    expect(getProjectTask(root, 'kept')?.archivedReason).toBe('duplicate-of:the-survivor')
    expect(getProjectTask(root, 'kept')?.deleteAt).toBe('2026-09-30T00:00:00Z')
  })

  test('an un-archive CLEARS the record rather than leaving a bare key behind', () => {
    createProjectTask(root, { title: 'Back', body: 'b', status: 'archived', ...LIFECYCLE }, 1000)
    updateProjectTask(root, 'back', { status: 'open', archivedReason: '', archivedBy: '' })

    const after = readFileSync(join(root, '.rclaude/project/cards/back.md'), 'utf8')
    expect(after).not.toContain('archived_reason')
    expect(after).not.toContain('archived_by')
    expect(getProjectTask(root, 'back')?.archivedReason).toBeUndefined()
  })
})

describe('the `model:` hint survives a round trip', () => {
  const cardFile = (id: string) => join(root, `.rclaude/project/cards/${id}.md`)

  test('createProjectTask writes it and getProjectTask reads it back', () => {
    const meta = createProjectTask(root, { title: 'Design job', body: 'b', model: 'opus' }, 1000)

    expect(meta.model).toBe('opus')
    expect(readFileSync(cardFile('design-job'), 'utf8')).toContain('model: opus')
    expect(getProjectTask(root, 'design-job')?.model).toBe('opus')
  })

  test('a slug nothing can resolve never reaches disk', () => {
    const meta = createProjectTask(root, { title: 'Bad hint', body: 'b', model: 'gpt-9' }, 1000)

    expect(meta.model).toBeUndefined()
    expect(readFileSync(cardFile('bad-hint'), 'utf8')).not.toContain('model:')
  })

  test('`#model-<slug>` is normalised into the key and does NOT stay a tag', () => {
    createProjectTask(root, { title: 'Typed on an iPad', body: 'b', tags: ['infra', 'model-sonnet'] }, 1000)

    const got = getProjectTask(root, 'typed-on-an-ipad')
    expect(got?.model).toBe('sonnet')
    expect(got?.tags).toEqual(['infra'])
  })

  test('an UNRECOGNISED `#model-` tag stays a tag -- the evidence is not eaten', () => {
    createProjectTask(root, { title: 'Odd tag', body: 'b', tags: ['model-frobnicate'] }, 1000)

    const got = getProjectTask(root, 'odd-tag')
    expect(got?.model).toBeUndefined()
    expect(got?.tags).toEqual(['model-frobnicate'])
  })

  test('an explicit field beats the tag when a caller says both', () => {
    createProjectTask(root, { title: 'Both', body: 'b', model: 'haiku', tags: ['model-opus'] }, 1000)

    const got = getProjectTask(root, 'both')
    expect(got?.model).toBe('haiku')
    expect(got?.tags).toEqual([])
  })

  test('a patch that does not mention it leaves it alone', () => {
    createProjectTask(root, { title: 'Kept hint', body: 'b', model: 'opus' }, 1000)
    updateProjectTask(root, 'kept-hint', { priority: 'high' })

    expect(getProjectTask(root, 'kept-hint')?.model).toBe('opus')
  })

  test('patching an unusable slug CLEARS the key rather than leaving the old one', () => {
    createProjectTask(root, { title: 'Overwritten', body: 'b', model: 'opus' }, 1000)
    updateProjectTask(root, 'overwritten', { model: 'gpt-9' })

    expect(getProjectTask(root, 'overwritten')?.model).toBeUndefined()
    expect(readFileSync(cardFile('overwritten'), 'utf8')).not.toContain('model:')
  })

  test('a card carrying an unusable slug still PROJECTS -- one typo hides no card', () => {
    createProjectTask(root, { title: 'Still here', body: 'b' }, 1000)
    const path = cardFile('still-here')
    writeFileSync(path, readFileSync(path, 'utf8').replace('status:', 'model: gpt-9\nstatus:'), 'utf8')

    const got = getProjectTask(root, 'still-here')
    expect(got?.title).toBe('Still here')
    expect(got?.model).toBeUndefined()
  })
})

/**
 * The end of the corruption `werk-promise-ledger-card-writer-flattens` names:
 * every board write goes through `serializeCard`, `project_set_status` included,
 * and a flat re-serialisation de-indented a card's `promise:` block and emptied
 * its `closes:`. A DELIVERED promise then read `not started` -- a confident wrong
 * answer, which is the one failure a ledger may never produce.
 *
 * Driven through the STORE and not the serializer, because the serializer was
 * never the thing that lost the block: a call site that forgot to thread it was.
 */
describe('a nested `promise:` block survives every board write', () => {
  const PROMISE = ['promise:', '  agreed: 2026-08-21', '  asked: "the ask"', '  closes:', '    - 83bf55f0  # the fix']

  function cardWithPromise(id: string): string {
    const abs = join(root, '.rclaude/project/cards', `${id}.md`)
    mkdirSync(join(root, '.rclaude/project/cards'), { recursive: true })
    writeFileSync(abs, ['---', 'title: A promise', 'status: open', ...PROMISE, '---', '', 'Body.', ''].join('\n'))
    return abs
  }

  test('setProjectTaskStatus keeps the block AND its closes list', () => {
    const abs = cardWithPromise('promised')
    expect(setProjectTaskStatus(root, 'promised', 'done', 2000)).toBe('open')

    const after = readFileSync(abs, 'utf8')
    expect(after).toContain(PROMISE.join('\n'))
    expect(after).toContain('status: done')
    expect(parsePromiseBlock(after)?.closes).toEqual(['83bf55f0'])
    expect(detectCardDefects(after)).toEqual([])
  })

  test('updateProjectTask keeps it too -- patching one key is not a licence to drop bytes', () => {
    const abs = cardWithPromise('promised')
    updateProjectTask(root, 'promised', { priority: 'high', tags: ['werk'] })

    const after = readFileSync(abs, 'utf8')
    expect(after).toContain(PROMISE.join('\n'))
    expect(after).toContain('priority: high')
    expect(parsePromiseBlock(after)?.asked).toBe('the ask')
  })

  test('repeated moves are idempotent -- the board does not churn a diff forever', () => {
    // Blocks are re-emitted after the flat keys, so the FIRST write may relocate
    // one. Every write after it must be byte-identical.
    const abs = cardWithPromise('promised')
    setProjectTaskStatus(root, 'promised', 'in-progress', 2000)
    const once = readFileSync(abs, 'utf8')
    setProjectTaskStatus(root, 'promised', 'in-progress', 3000)
    expect(readFileSync(abs, 'utf8')).toBe(once)
  })
})
