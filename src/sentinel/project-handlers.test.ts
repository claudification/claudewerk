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

// The dispatch became async when `sweep` landed -- that op awaits the fold's
// optional duplicate judge. Every other op is still synchronous underneath; the
// `await` here is the envelope, not the work.
function op(fields: Partial<ProjectBoardOp> & Pick<ProjectBoardOp, 'op'>) {
  return handleProjectBoardOp(
    root,
    { type: 'project_board_op', requestId: 'r1', projectRoot: root, ...fields } as ProjectBoardOp,
    NOW,
  )
}
async function seed(title: string) {
  const r = await op({ op: 'create', input: { title, body: 'body' } })
  return r.note?.slug as string
}

describe('handleProjectBoardOp', () => {
  test('create -> list -> manifest -> get', async () => {
    const id = await seed('Do the thing')
    expect(id).toBe('do-the-thing')

    const list = await op({ op: 'list' })
    expect(list.ok).toBe(true)
    expect(list.tasks?.map(t => t.slug)).toEqual([id])

    expect((await op({ op: 'manifest' })).manifest?.[0]).toMatchObject({ slug: id, status: 'inbox' })
    expect((await op({ op: 'get', slug: id })).task?.body).toBe('body')
  })

  test('list honours filterStatus', async () => {
    await seed('a')
    await op({ op: 'move', slug: 'a', toStatus: 'done' })
    await seed('b')
    expect((await op({ op: 'list', filterStatus: 'done' })).tasks?.map(t => t.slug)).toEqual(['a'])
    expect((await op({ op: 'list', filterStatus: 'inbox' })).tasks?.map(t => t.slug)).toEqual(['b'])
  })

  test('getBatch hydrates by id and skips misses', async () => {
    await seed('a')
    const r = await op({
      op: 'getBatch',
      refs: [
        { slug: 'a', status: 'inbox' },
        { slug: 'ghost', status: 'done' },
      ],
    })
    expect(r.batch?.map(t => t.slug)).toEqual(['a'])
  })

  test('move returns the UNCHANGED id and rewrites only the lane', async () => {
    const id = await seed('movable')
    const r = await op({ op: 'move', slug: id, toStatus: 'in-review' })
    expect(r.ok).toBe(true)
    expect(r.slug).toBe(id)
    expect((await op({ op: 'get', slug: id })).task?.status).toBe('in-review')
  })

  test('move reports null for a card that does not exist', async () => {
    expect((await op({ op: 'move', slug: 'ghost', toStatus: 'done' })).slug).toBeNull()
  })

  test('update patches and delete removes', async () => {
    const id = await seed('patchable')
    expect((await op({ op: 'update', slug: id, patch: { body: 'new body' } })).task?.body).toBe('new body')
    expect((await op({ op: 'delete', slug: id })).removed).toBe(true)
    expect((await op({ op: 'get', slug: id })).task).toBeNull()
    expect((await op({ op: 'delete', slug: id })).removed).toBe(false)
  })

  test('a legacy status hint from an older broker is accepted and ignored', async () => {
    const id = await seed('hinted')
    await op({ op: 'move', slug: id, toStatus: 'done' })
    // The broker still sends the lane it believed the card was in. It is wrong,
    // and that must not matter.
    expect((await op({ op: 'get', slug: id, status: 'inbox' })).task?.status).toBe('done')
    expect((await op({ op: 'move', slug: id, fromStatus: 'inbox', toStatus: 'archived' })).slug).toBe(id)
    expect((await op({ op: 'delete', slug: id, status: 'open' })).removed).toBe(true)
  })

  test('a card still in a legacy lane dir is readable and movable', async () => {
    mkdirSync(join(root, '.rclaude/project/in-progress'), { recursive: true })
    writeFileSync(join(root, '.rclaude/project/in-progress/old.md'), '---\ntitle: Old\n---\n\nlegacy')

    expect((await op({ op: 'get', slug: 'old' })).task?.status).toBe('in-progress')
    expect((await op({ op: 'move', slug: 'old', toStatus: 'done' })).slug).toBe('old')
    expect((await op({ op: 'get', slug: 'old' })).task?.status).toBe('done')
  })

  test('missing required fields are rejected per op, not thrown', async () => {
    for (const o of ['get', 'update', 'delete'] as const) {
      expect(await op({ op: o })).toMatchObject({ ok: false, error: 'slug required' })
    }
    expect(await op({ op: 'move', slug: 'x' })).toMatchObject({ ok: false, error: 'slug+toStatus required' })
    expect(await op({ op: 'create' })).toMatchObject({ ok: false, error: 'input required' })
    expect(await op({ op: 'sweep' })).toMatchObject({ ok: false, error: 'sweep params required' })
    expect(await op({ op: 'apply' })).toMatchObject({ ok: false, error: 'apply params required' })
  })

  test('an unknown op is an error, not a crash', async () => {
    expect(await op({ op: 'nope' as ProjectBoardOp['op'] })).toMatchObject({ ok: false })
  })

  test('every result echoes requestId and op', async () => {
    const r = await op({ op: 'list' })
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

  async function pin(slug: string, children: { slug: string; status: 'open' | 'done' | 'archived' }[]) {
    await op({ op: 'create', input: { title: slug, body: 'b', status: 'open', tags: ['epic'], wallPinned: true } })
    for (const c of children) {
      await op({ op: 'create', input: { title: c.slug, body: 'b', status: c.status, epic: slug } })
    }
  }

  test('returns the pinned epics with their counts, stamped with the project URI', async () => {
    await pin('watched', [
      { slug: 'a', status: 'done' },
      { slug: 'b', status: 'open' },
    ])
    const r = await handleProjectBoardOp(
      root,
      { type: 'project_board_op', requestId: 'r1', projectRoot: root, project: URI, op: 'pinned' },
      NOW,
    )

    expect(r.ok).toBe(true)
    expect(r.pinned).toHaveLength(1)
    expect(r.pinned?.[0]).toMatchObject({ project: URI, epicId: 'watched', done: 1, total: 2, pct: 50 })
    expect(r.pinned?.[0].children.map(c => c.slug)).toEqual(['b'])
  })

  test('an unpinned epic never crosses the wire, and neither does the board', async () => {
    await op({ op: 'create', input: { title: 'unwatched', body: 'b', tags: ['epic'] } })
    await op({ op: 'create', input: { title: 'loose card', body: 'b' } })

    const r = await op({ op: 'pinned' })
    expect(r.ok).toBe(true)
    expect(r.pinned).toEqual([])
    // The whole point: no `tasks`, no `manifest`, no `batch` riding along.
    expect(r.tasks).toBeUndefined()
    expect(r.batch).toBeUndefined()
  })

  test('an empty board is an empty list, not a failure', async () => {
    expect(await op({ op: 'pinned' })).toMatchObject({ ok: true, pinned: [] })
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
  test('create keeps status, quest, epic and linkage', async () => {
    const r = await op({
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
    const task = (await op({ op: 'get', slug: r.note?.slug as string })).task
    expect(task).toMatchObject({
      status: 'open',
      quest: 'q1',
      epic: 'the-epic',
      dependsOn: ['a'],
      relatesTo: ['b'],
    })
  })

  test('blocked_by crosses the wire and lands as depends_on', async () => {
    const r = await op({ op: 'create', input: { title: 'Aliased', body: 'b', blockedBy: ['x'] } })
    expect((await op({ op: 'get', slug: r.note?.slug as string })).task?.dependsOn).toEqual(['x'])
  })

  test('update patches linkage too', async () => {
    const id = await seed('Patched')
    await op({ op: 'update', slug: id, patch: { epic: 'e', relatesTo: ['r'] } })
    expect((await op({ op: 'get', slug: id })).task).toMatchObject({ epic: 'e', relatesTo: ['r'] })
  })
})
