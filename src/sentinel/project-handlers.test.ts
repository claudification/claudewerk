import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectBoardOp } from '../shared/protocol'
import { handleProjectBoardOp } from './project-handlers'

let root: string
const NOW = 1_000_000

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-handlers-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function op(fields: Partial<ProjectBoardOp> & Pick<ProjectBoardOp, 'op'>) {
  return handleProjectBoardOp(
    root,
    { type: 'project_board_op', requestId: 'r1', projectRoot: root, ...fields } as ProjectBoardOp,
    NOW,
  )
}
function seed(title: string) {
  const r = op({ op: 'create', input: { title, body: 'body' } })
  return r.note?.slug as string
}

describe('handleProjectBoardOp', () => {
  test('create -> list -> manifest -> get', () => {
    const id = seed('Do the thing')
    expect(id).toBe('do-the-thing')

    const list = op({ op: 'list' })
    expect(list.ok).toBe(true)
    expect(list.tasks?.map(t => t.slug)).toEqual([id])

    expect(op({ op: 'manifest' }).manifest?.[0]).toMatchObject({ slug: id, status: 'inbox' })
    expect(op({ op: 'get', slug: id }).task?.body).toBe('body')
  })

  test('list honours filterStatus', () => {
    seed('a')
    op({ op: 'move', slug: 'a', toStatus: 'done' })
    seed('b')
    expect(op({ op: 'list', filterStatus: 'done' }).tasks?.map(t => t.slug)).toEqual(['a'])
    expect(op({ op: 'list', filterStatus: 'inbox' }).tasks?.map(t => t.slug)).toEqual(['b'])
  })

  test('getBatch hydrates by id and skips misses', () => {
    seed('a')
    const r = op({
      op: 'getBatch',
      refs: [
        { slug: 'a', status: 'inbox' },
        { slug: 'ghost', status: 'done' },
      ],
    })
    expect(r.batch?.map(t => t.slug)).toEqual(['a'])
  })

  test('move returns the UNCHANGED id and rewrites only the lane', () => {
    const id = seed('movable')
    const r = op({ op: 'move', slug: id, toStatus: 'in-review' })
    expect(r.ok).toBe(true)
    expect(r.slug).toBe(id)
    expect(op({ op: 'get', slug: id }).task?.status).toBe('in-review')
  })

  test('move reports null for a card that does not exist', () => {
    expect(op({ op: 'move', slug: 'ghost', toStatus: 'done' }).slug).toBeNull()
  })

  test('update patches and delete removes', () => {
    const id = seed('patchable')
    expect(op({ op: 'update', slug: id, patch: { body: 'new body' } }).task?.body).toBe('new body')
    expect(op({ op: 'delete', slug: id }).removed).toBe(true)
    expect(op({ op: 'get', slug: id }).task).toBeNull()
    expect(op({ op: 'delete', slug: id }).removed).toBe(false)
  })

  test('a legacy status hint from an older broker is accepted and ignored', () => {
    const id = seed('hinted')
    op({ op: 'move', slug: id, toStatus: 'done' })
    // The broker still sends the lane it believed the card was in. It is wrong,
    // and that must not matter.
    expect(op({ op: 'get', slug: id, status: 'inbox' }).task?.status).toBe('done')
    expect(op({ op: 'move', slug: id, fromStatus: 'inbox', toStatus: 'archived' }).slug).toBe(id)
    expect(op({ op: 'delete', slug: id, status: 'open' }).removed).toBe(true)
  })

  test('a card still in a legacy lane dir is readable and movable', () => {
    mkdirSync(join(root, '.rclaude/project/in-progress'), { recursive: true })
    writeFileSync(join(root, '.rclaude/project/in-progress/old.md'), '---\ntitle: Old\n---\n\nlegacy')

    expect(op({ op: 'get', slug: 'old' }).task?.status).toBe('in-progress')
    expect(op({ op: 'move', slug: 'old', toStatus: 'done' }).slug).toBe('old')
    expect(op({ op: 'get', slug: 'old' }).task?.status).toBe('done')
  })

  test('missing required fields are rejected per op, not thrown', () => {
    for (const o of ['get', 'update', 'delete'] as const) {
      expect(op({ op: o })).toMatchObject({ ok: false, error: 'slug required' })
    }
    expect(op({ op: 'move', slug: 'x' })).toMatchObject({ ok: false, error: 'slug+toStatus required' })
    expect(op({ op: 'create' })).toMatchObject({ ok: false, error: 'input required' })
  })

  test('an unknown op is an error, not a crash', () => {
    expect(op({ op: 'nope' as ProjectBoardOp['op'] })).toMatchObject({ ok: false })
  })

  test('every result echoes requestId and op', () => {
    const r = op({ op: 'list' })
    expect(r.requestId).toBe('r1')
    expect(r.op).toBe('list')
    expect(r.type).toBe('project_board_result')
  })
})

/**
 * THE WALL's A8 fold, run beside the files.
 *
 * What these lock down is the reason the op exists: the wire carries the ROWS,
 * never the board. A `pinned` that answered with every card would be a `list`
 * with extra steps, and the browser-side fold it replaced is exactly that.
 */
describe('the pinned op folds A8 on the sentinel', () => {
  const URI = 'claude:///Users/j/remote-claude'

  function pin(slug: string, children: { slug: string; status: 'open' | 'done' | 'archived' }[]) {
    op({ op: 'create', input: { title: slug, body: 'b', status: 'open', tags: ['epic'], wallPinned: true } })
    for (const c of children) {
      op({ op: 'create', input: { title: c.slug, body: 'b', status: c.status, epic: slug } })
    }
  }

  test('returns the pinned epics with their counts, stamped with the project URI', () => {
    pin('watched', [
      { slug: 'a', status: 'done' },
      { slug: 'b', status: 'open' },
    ])
    const r = handleProjectBoardOp(
      root,
      { type: 'project_board_op', requestId: 'r1', projectRoot: root, project: URI, op: 'pinned' },
      NOW,
    )

    expect(r.ok).toBe(true)
    expect(r.pinned).toHaveLength(1)
    expect(r.pinned?.[0]).toMatchObject({ project: URI, epicId: 'watched', done: 1, total: 2, pct: 50 })
    expect(r.pinned?.[0].children.map(c => c.slug)).toEqual(['b'])
  })

  test('an unpinned epic never crosses the wire, and neither does the board', () => {
    op({ op: 'create', input: { title: 'unwatched', body: 'b', tags: ['epic'] } })
    op({ op: 'create', input: { title: 'loose card', body: 'b' } })

    const r = op({ op: 'pinned' })
    expect(r.ok).toBe(true)
    expect(r.pinned).toEqual([])
    // The whole point: no `tasks`, no `manifest`, no `batch` riding along.
    expect(r.tasks).toBeUndefined()
    expect(r.batch).toBeUndefined()
  })

  test('an empty board is an empty list, not a failure', () => {
    expect(op({ op: 'pinned' })).toMatchObject({ ok: true, pinned: [] })
  })
})

/**
 * `ProjectTaskInputWire` used to declare only title/body/priority/tags/refs, so
 * a caller writing `input: { epic: 'x' }` got a type error and reasonably
 * concluded the board could not be told. Nothing was dropped at runtime -- the
 * envelope is forwarded whole -- but an understated contract is indistinguishable
 * from an absent feature from the caller's side. These lock the real one down.
 */
describe('the wire carries the WHOLE input, not the five fields it started with', () => {
  test('create keeps status, quest, epic and linkage', () => {
    const r = op({
      op: 'create',
      input: {
        title: 'Wired',
        body: 'b',
        status: 'open',
        quest: 'q1',
        epic: 'the-epic',
        dependsOn: ['a'],
        relatesTo: ['b'],
      },
    })
    const task = op({ op: 'get', slug: r.note?.slug as string }).task
    expect(task).toMatchObject({
      status: 'open',
      quest: 'q1',
      epic: 'the-epic',
      dependsOn: ['a'],
      relatesTo: ['b'],
    })
  })

  test('blocked_by crosses the wire and lands as depends_on', () => {
    const r = op({ op: 'create', input: { title: 'Aliased', body: 'b', blockedBy: ['x'] } })
    expect(op({ op: 'get', slug: r.note?.slug as string }).task?.dependsOn).toEqual(['x'])
  })

  test('update patches linkage too', () => {
    const id = seed('Patched')
    op({ op: 'update', slug: id, patch: { epic: 'e', relatesTo: ['r'] } })
    expect(op({ op: 'get', slug: id }).task).toMatchObject({ epic: 'e', relatesTo: ['r'] })
  })
})
