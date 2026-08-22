/**
 * THE ONE BUILDER for the nightshift scan's deps.
 *
 * `buildNightshiftScanDeps` is the wiring both the DISPATCH path
 * (`scanBoardForTasks`) and the READ path (`outlookForProject`) now come
 * through. These are facts about that wiring: which board ops it can reach,
 * which it deliberately cannot, and what it leaves to the caller.
 *
 * The `call` and the store are plain fakes -- no broker, no sentinel, no board.
 */

import { describe, expect, test } from 'bun:test'
import { NIGHTSHIFT_TAG } from '../shared/nightshift-types'
import type { ProjectTask, ProjectTaskMeta } from '../shared/project-task-types'
import type { Conversation } from '../shared/protocol'
import type { CallBoard } from './board-cards'
import type { ConversationStore } from './conversation-store'
import { buildNightshiftScanDeps } from './nightshift-board'

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open',
    title: `card ${slug}`,
    tags: [NIGHTSHIFT_TAG],
    refs: [],
    created: '2026-08-01T00:00:00Z',
    mtime: 0,
    bodyPreview: '',
    ...over,
  }
}

const full = (meta: ProjectTaskMeta): ProjectTask => ({ ...meta, body: `body of ${meta.slug}` })

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return { id, status: 'active', lastActivity: 0, ...over } as Conversation
}

/** Records every op the deps issue, so a WRITE is visible as a failed assertion
 *  rather than as something that quietly happened to a real board. */
function recordingCall(cards: ProjectTaskMeta[]) {
  const ops: string[] = []
  const call = ((_store: ConversationStore, _project: string, op: { op: string; slug?: string }) => {
    ops.push(op.slug ? `${op.op}:${op.slug}` : op.op)
    if (op.op === 'list') return Promise.resolve({ ok: true, tasks: cards })
    if (op.op === 'get') {
      const hit = cards.find(c => c.slug === op.slug)
      return Promise.resolve({ ok: true, task: hit ? full(hit) : null })
    }
    return Promise.resolve({ ok: true })
  }) as unknown as CallBoard
  return { call, ops }
}

function fakeStore(convs: Conversation[] = [], active: Record<string, number> = {}): ConversationStore {
  return {
    getAllConversations: () => convs,
    getActiveConversationCount: (id: string) => active[id] ?? 0,
  } as unknown as ConversationStore
}

describe('buildNightshiftScanDeps', () => {
  test('wires the board reads through the call it was given', async () => {
    const { call, ops } = recordingCall([card('a'), card('b')])
    const deps = buildNightshiftScanDeps(call, fakeStore(), 'claude://p', 8)

    expect((await deps.listCards()).map(c => c.slug)).toEqual(['a', 'b'])
    expect((await deps.readCard('b'))?.body).toBe('body of b')
    expect(await deps.readCard('missing')).toBeNull()
    expect(ops).toEqual(['list', 'get:b', 'get:missing'])
  })

  test('DRY RUN BY CONSTRUCTION: exercising every dep issues no write op', async () => {
    const { call, ops } = recordingCall([card('a')])
    const deps = buildNightshiftScanDeps(call, fakeStore(), 'claude://p', 8)

    await deps.listCards()
    await deps.readCard('a')
    deps.getAllConversations()
    deps.isLive(conv('c1'))
    deps.now()
    deps.log('noise')

    // `clearCardTag` -- THE DRAIN -- is not reachable from these deps, which
    // is what lets the Outlook pane share the run's exact wiring and still be a
    // preview. A future field that writes would show up right here.
    expect(ops.every(o => o.startsWith('list') || o.startsWith('get:'))).toBe(true)
  })

  test('isLive is the werk rule: ended AND socketless is dead, ended-with-socket is not', () => {
    const ended = conv('dead', { status: 'ended' })
    const teardown = conv('mid', { status: 'ended' })
    const deps = buildNightshiftScanDeps(
      recordingCall([]).call,
      fakeStore([ended, teardown], { mid: 1 }),
      'claude://p',
      8,
    )

    expect(deps.isLive(ended)).toBe(false)
    expect(deps.isLive(teardown)).toBe(true)
    expect(deps.isLive(conv('running'))).toBe(true)
  })

  test('reads the registry live, not a snapshot taken at build time', () => {
    const convs: Conversation[] = []
    const deps = buildNightshiftScanDeps(recordingCall([]).call, fakeStore(convs), 'claude://p', 8)

    expect(deps.getAllConversations()).toHaveLength(0)
    convs.push(conv('late'))
    expect(deps.getAllConversations()).toHaveLength(1)
  })

  test('passes project and totalTasks through, and leaves `admitted` to the caller', () => {
    const deps = buildNightshiftScanDeps(recordingCall([]).call, fakeStore(), 'claude://proj', 3)

    expect(deps.project).toBe('claude://proj')
    expect(deps.totalTasks).toBe(3)
    // The one field the dispatch path and the read path must NOT share: one
    // pushes into the run's pending list, the other into a throwaway.
    expect('admitted' in deps).toBe(false)
  })
})
