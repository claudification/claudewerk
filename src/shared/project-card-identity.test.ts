/**
 * The card-identity contract (project-paths.ts): a card's path is fixed for
 * life, its lane is frontmatter, old lane links keep resolving, and no write
 * may destroy frontmatter keys the store doesn't know about.
 *
 * These are the regressions that motivated the layout change -- each test here
 * FAILS against the old `(status, slug)` store.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canonicalizeCardPath,
  cardPath,
  createProjectTask,
  deleteProjectTask,
  getProjectTask,
  hasLegacyCards,
  listLegacyCollisions,
  listProjectManifest,
  listProjectTasks,
  moveProjectTask,
  readProjectFile,
  rebuildProjectViews,
  setProjectTaskStatus,
  updateProjectTask,
  viewsSupported,
} from './project-store'
import type { TaskStatus } from './task-statuses'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'card-identity-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function lane(status: TaskStatus, id: string, content: string): void {
  mkdirSync(join(root, '.rclaude/project', status), { recursive: true })
  writeFileSync(join(root, '.rclaude/project', status, `${id}.md`), content)
}

describe('identity is the id, and only the id', () => {
  test('the card file never moves, whatever its lane', () => {
    const { slug } = createProjectTask(root, { title: 'stable', body: 'x' }, 1000)
    const abs = cardPath(root, slug, false)
    expect(existsSync(abs)).toBe(true)

    for (const status of ['open', 'in-progress', 'in-review', 'done'] as TaskStatus[]) {
      setProjectTaskStatus(root, slug, status, 2000)
      expect(existsSync(abs)).toBe(true)
      expect(getProjectTask(root, slug)?.status).toBe(status)
    }
  })

  test('a status change can never rename the card, even into a collision', () => {
    createProjectTask(root, { title: 'x', body: 'first' }, 1000)
    const second = createProjectTask(root, { title: 'x', body: 'second' }, 1001)
    expect(second.slug).toBe('x-2')

    // The old store deduped on MOVE and renamed the card out from under every
    // link pointing at it. Both cards land in `done` keeping their own ids.
    setProjectTaskStatus(root, 'x', 'done', 2000)
    setProjectTaskStatus(root, 'x-2', 'done', 2000)
    expect(getProjectTask(root, 'x')?.body).toBe('first')
    expect(getProjectTask(root, 'x-2')?.body).toBe('second')
  })

  test('setProjectTaskStatus reports the previous lane', () => {
    createProjectTask(root, { title: 'p', body: '' }, 1000)
    expect(setProjectTaskStatus(root, 'p', 'open', 1001)).toBe('inbox')
    expect(setProjectTaskStatus(root, 'p', 'done', 1002)).toBe('open')
  })

  test('the deprecated moveProjectTask shim returns the unchanged id', () => {
    createProjectTask(root, { title: 'shim', body: '' }, 1000)
    expect(moveProjectTask(root, 'shim', 'inbox', 'done', 2000)).toBe('shim')
    expect(getProjectTask(root, 'shim')?.status).toBe('done')
    // The `fromStatus` argument is ignored -- a stale caller cannot miss.
    expect(moveProjectTask(root, 'shim', 'inbox', 'archived', 2001)).toBe('shim')
    expect(getProjectTask(root, 'shim')?.status).toBe('archived')
  })
})

describe('frontmatter survives every write', () => {
  test('update preserves gate evidence and other unknown keys', () => {
    const { slug } = createProjectTask(root, { title: 'gated', body: 'body' }, 1000)
    const abs = cardPath(root, slug, false)
    writeFileSync(
      abs,
      readFileSync(abs, 'utf8').replace(
        '---\ntitle',
        '---\ngate: full\ntest_cmd: bun test\nevidence_branch: wt/x\nevidence_worker: conv_abc\ntitle',
      ),
    )

    updateProjectTask(root, slug, { body: 'rewritten by a Guard bounce' })
    const after = readFileSync(abs, 'utf8')
    expect(after).toContain('gate: full')
    expect(after).toContain('test_cmd: bun test')
    expect(after).toContain('evidence_branch: wt/x')
    expect(after).toContain('evidence_worker: conv_abc')
    expect(after).toContain('rewritten by a Guard bounce')
  })

  test('a status change preserves them too', () => {
    const { slug } = createProjectTask(root, { title: 'g2', body: 'b' }, 1000)
    const abs = cardPath(root, slug, false)
    writeFileSync(abs, readFileSync(abs, 'utf8').replace('---\ntitle', '---\nevidence_base: main\ntitle'))
    setProjectTaskStatus(root, slug, 'done', 2000)
    expect(readFileSync(abs, 'utf8')).toContain('evidence_base: main')
  })

  test('quest membership is orthogonal to the lane', () => {
    const { slug } = createProjectTask(root, { title: 'q', body: '', quest: 'floppy-panda' }, 1000)
    setProjectTaskStatus(root, slug, 'in-review', 2000)
    expect(getProjectTask(root, slug)?.quest).toBe('floppy-panda')
  })
})

describe('legacy lanes', () => {
  test('a lane-resident card is readable, with its lane as its status', () => {
    lane('in-progress', 'old', '---\ntitle: Old card\n---\n\nlegacy body')
    expect(hasLegacyCards(root)).toBe(true)
    expect(getProjectTask(root, 'old')?.status).toBe('in-progress')
    expect(getProjectTask(root, 'old')?.body).toBe('legacy body')
    expect(listProjectTasks(root).find(t => t.slug === 'old')?.status).toBe('in-progress')
    expect(listProjectManifest(root).find(m => m.slug === 'old')?.status).toBe('in-progress')
  })

  test('reading never moves it, writing does (lazy migration)', () => {
    lane('open', 'lazy', '---\ntitle: Lazy\n---\n\nbody')
    getProjectTask(root, 'lazy')
    expect(existsSync(join(root, '.rclaude/project/open/lazy.md'))).toBe(true)

    updateProjectTask(root, 'lazy', { body: 'touched' })
    expect(existsSync(join(root, '.rclaude/project/open/lazy.md'))).toBe(false)
    expect(existsSync(cardPath(root, 'lazy', false))).toBe(true)
    // The lane directory was its only status record -- pinned on the way out.
    expect(getProjectTask(root, 'lazy')?.status).toBe('open')
    expect(readFileSync(cardPath(root, 'lazy', false), 'utf8')).toContain('status: open')
  })

  test('a canonical card shadows a same-id legacy straggler', () => {
    createProjectTask(root, { title: 'both', body: 'canonical' }, 1000)
    lane('done', 'both', '---\ntitle: both\n---\n\nstale')
    expect(getProjectTask(root, 'both')?.body).toBe('canonical')
    expect(listProjectTasks(root).filter(t => t.slug === 'both')).toHaveLength(1)
  })

  test('same id in two lanes resolves to the furthest along, and is reported', () => {
    lane('open', 'clash', '---\ntitle: clash\n---\n\nearly')
    lane('done', 'clash', '---\ntitle: clash\n---\n\nlate')
    expect(getProjectTask(root, 'clash')?.status).toBe('done')
    expect(listLegacyCollisions(root)).toEqual([{ slug: 'clash', lanes: ['open', 'done'] }])
  })
})

describe('old links keep resolving', () => {
  test('canonicalizeCardPath maps every historical shape to the card', () => {
    for (const p of [
      '.rclaude/project/open/x.md',
      './.rclaude/project/archived/x.md',
      'some/repo/.rclaude/project/in-review/x.md',
      '.rclaude/project/views/done/x.md',
      '.rclaude/project/cards/x.md',
    ]) {
      expect(canonicalizeCardPath(p)).toEqual({ id: 'x', relPath: '.rclaude/project/cards/x.md' })
    }
    expect(canonicalizeCardPath('.rclaude/project/open/x.md#section')?.id).toBe('x')
    expect(canonicalizeCardPath('docs/readme.md')).toBeNull()
    expect(canonicalizeCardPath('.rclaude/project/priority.md')).toBeNull()
  })

  test('the file viewer falls back to the card when a lane path is dead', () => {
    const { slug } = createProjectTask(root, { title: 'viewme', body: 'the body' }, 1000)
    setProjectTaskStatus(root, slug, 'done', 2000)
    // Nothing has ever existed at this path on this board.
    const r = readProjectFile(root, '.rclaude/project/open/viewme.md')
    expect(r.ok).toBe(true)
    expect(r.content).toContain('the body')
  })

  test('the fallback does not fire for non-card paths', () => {
    expect(readProjectFile(root, '.rclaude/project/priority.md').ok).toBe(false)
    expect(readProjectFile(root, '../../etc/passwd').ok).toBe(false)
  })
})

describe('views symlink farm', () => {
  const viewLink = (status: string, id: string) => join(root, '.rclaude/project/views', status, `${id}.md`)

  test('a card is linked from its current lane only', () => {
    if (!viewsSupported()) return
    const { slug } = createProjectTask(root, { title: 'v', body: '' }, 1000)
    expect(lstatSync(viewLink('inbox', slug)).isSymbolicLink()).toBe(true)

    setProjectTaskStatus(root, slug, 'done', 2000)
    expect(existsSync(viewLink('inbox', slug))).toBe(false)
    expect(readFileSync(viewLink('done', slug), 'utf8')).toContain('title: v')
  })

  test('deleting a card drops its views', () => {
    if (!viewsSupported()) return
    const { slug } = createProjectTask(root, { title: 'gone', body: '' }, 1000)
    deleteProjectTask(root, slug)
    expect(existsSync(viewLink('inbox', slug))).toBe(false)
  })

  test('rebuild is idempotent and prunes strays', () => {
    if (!viewsSupported()) return
    createProjectTask(root, { title: 'a', body: '' }, 1000)
    createProjectTask(root, { title: 'b', body: '' }, 1001)
    const cards = listProjectManifest(root).map(m => ({ slug: m.slug, status: m.status }))

    expect(rebuildProjectViews(root, cards)).toMatchObject({ created: 0, pruned: 0 })

    mkdirSync(join(root, '.rclaude/project/views/done'), { recursive: true })
    writeFileSync(viewLink('done', 'ghost'), 'not even a link')
    expect(rebuildProjectViews(root, cards).pruned).toBe(1)
    expect(existsSync(viewLink('done', 'ghost'))).toBe(false)
  })

  test('the board still works when the farm is nuked', () => {
    const { slug } = createProjectTask(root, { title: 'resilient', body: '' }, 1000)
    rmSync(join(root, '.rclaude/project/views'), { recursive: true, force: true })
    expect(getProjectTask(root, slug)?.title).toBe('resilient')
    expect(setProjectTaskStatus(root, slug, 'done', 2000)).toBe('inbox')
  })
})
