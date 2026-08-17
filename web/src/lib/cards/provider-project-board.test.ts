import type { ProjectTaskMeta } from '@shared/project-task-types'
import type { TaskStatus } from '@shared/task-statuses'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const board = vi.hoisted(() => ({
  cards: [] as ProjectTaskMeta[],
  manifestFetched: true,
  refetching: false,
  hydrated: true,
  /** False = the manifest knows the card but its detail has not been hydrated. */
  metaVisible: true,
  project: 'claude://studio/proj' as string | null,
}))

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: {
    getState: () => ({
      selectedConversationId: 'conv',
      conversationsById: { conv: { project: board.project } },
    }),
    subscribe: () => () => {},
  },
}))

vi.mock('@/hooks/project-task-cache', () => ({ subscribeProjectCache: () => () => {} }))

vi.mock('@/hooks/project-card-lookup', () => ({
  boardVersion: () => board.cards.length,
  isBoardHydrated: () => board.hydrated,
  peekProjectMeta: () => board.cards,
  ensureProjectCard: vi.fn(),
  hydrateProjectBoard: vi.fn(),
  peekProjectCard: (_scope: string, slug: string) => {
    const meta = board.cards.find(c => c.slug === slug)
    return {
      manifestFetched: board.manifestFetched,
      refetching: board.refetching,
      entry: meta ? { slug: meta.slug, status: meta.status, mtime: meta.mtime } : undefined,
      meta: board.metaVisible ? meta : undefined,
    }
  },
}))

const { projectBoardProvider } = await import('./provider-project-board')

function card(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status,
    title: `Title of ${slug}`,
    tags: [],
    refs: [],
    created: '2026-08-01T10:00:00.000Z',
    mtime: 1_700_000_000_000,
    bodyPreview: '',
    ...over,
  }
}

function peek(id: string) {
  const ref = projectBoardProvider.matchHref(`.rclaude/project/cards/${id}.md`)
  if (!ref) throw new Error('href did not match')
  return projectBoardProvider.peek(ref)
}

beforeEach(() => {
  board.cards = []
  board.manifestFetched = true
  board.hydrated = true
  board.metaVisible = true
  board.project = 'claude://studio/proj'
})

describe('project board provider -- href matching', () => {
  it('claims a card path and stamps the ambient project as scope', () => {
    expect(projectBoardProvider.matchHref('.rclaude/project/cards/foo.md')).toEqual({
      provider: 'project-board',
      id: 'foo',
      scope: 'claude://studio/proj',
    })
  })

  it('ignores a plain file link', () => {
    expect(projectBoardProvider.matchHref('docs/ops.md')).toBeNull()
  })

  it('reports unavailable with no project selected', () => {
    board.project = null
    expect(peek('foo')).toEqual({ status: 'unavailable' })
  })
})

describe('project board provider -- lane to canonical state', () => {
  const cases: [TaskStatus, string][] = [
    ['inbox', 'triage'],
    ['open', 'todo'],
    ['in-progress', 'active'],
    ['in-review', 'review'],
    ['done', 'done'],
    ['archived', 'dropped'],
  ]

  it.each(cases)('maps %s to %s and keeps the lane word verbatim', (lane, state) => {
    board.cards = [card('c', lane)]
    const lookup = peek('c')
    expect(lookup.status).toBe('ready')
    if (lookup.status !== 'ready') return
    expect(lookup.summary.state).toBe(state)
    expect(lookup.summary.statusLabel).toBe(lane)
  })
})

describe('project board provider -- resolution states', () => {
  it('is resolving while the manifest has not landed', () => {
    board.manifestFetched = false
    expect(peek('nope')).toEqual({ status: 'resolving' })
  })

  it('is unknown once the manifest is in and the id is not on it', () => {
    expect(peek('nope')).toEqual({ status: 'unknown' })
  })

  it('answers from the manifest alone before detail lands -- state now, title later', () => {
    board.cards = [card('c', 'in-review')]
    board.metaVisible = false
    const lookup = peek('c')
    if (lookup.status !== 'ready') throw new Error('expected ready')
    expect(lookup.summary).toMatchObject({ detail: 'partial', state: 'review', kind: 'card' })
    expect(lookup.summary.title).toBeUndefined()
  })
})

describe('project board provider -- epics', () => {
  it('is an epic when tagged, and rolls its children up', () => {
    board.cards = [
      card('e', 'in-progress', { tags: ['epic'] }),
      card('a', 'done', { epic: 'e' }),
      card('b', 'in-review', { epic: 'e' }),
      card('c', 'open', { epic: 'e' }),
    ]
    const lookup = peek('e')
    if (lookup.status !== 'ready') throw new Error('expected ready')
    expect(lookup.summary.kind).toBe('epic')
    expect(lookup.summary.progress).toEqual({ todo: 1, active: 1, done: 1, dropped: 0, total: 3, pct: 33 })
  })

  it('is an epic when untagged but claimed as a parent -- only once the board is hydrated', () => {
    board.cards = [card('e', 'open'), card('a', 'done', { epic: 'e' })]
    const hydrated = peek('e')
    if (hydrated.status !== 'ready') throw new Error('expected ready')
    expect(hydrated.summary.kind).toBe('epic')

    board.hydrated = false
    const partial = peek('e')
    if (partial.status !== 'ready') throw new Error('expected ready')
    expect(partial.summary.kind).toBe('card')
    expect(partial.summary.progress).toBeUndefined()
  })

  it('leaves archived children OUT of the denominator', () => {
    board.cards = [
      card('e', 'in-progress', { tags: ['epic'] }),
      card('a', 'done', { epic: 'e' }),
      card('b', 'archived', { epic: 'e' }),
    ]
    const lookup = peek('e')
    if (lookup.status !== 'ready') throw new Error('expected ready')
    expect(lookup.summary.progress).toEqual({ todo: 0, active: 0, done: 1, dropped: 1, total: 1, pct: 100 })
  })

  it('reports no percentage for an epic whose children were all dropped', () => {
    board.cards = [card('e', 'open', { tags: ['epic'] }), card('a', 'archived', { epic: 'e' })]
    const lookup = peek('e')
    if (lookup.status !== 'ready') throw new Error('expected ready')
    expect(lookup.summary.progress).toMatchObject({ total: 0, pct: null, dropped: 1 })
  })
})

describe('an absence claim is only made when nothing could contradict it', () => {
  beforeEach(() => {
    board.cards = []
    board.manifestFetched = true
    board.refetching = false
  })

  it('claims unknown when the manifest is current and nothing is in flight', () => {
    expect(peek('ghost')).toEqual({ status: 'unknown' })
  })

  it('stays RESOLVING while a stale-miss re-check is in flight', () => {
    board.refetching = true
    expect(peek('card-written-a-moment-ago')).toEqual({ status: 'resolving' })
  })

  it('stays resolving before the first manifest lands', () => {
    board.manifestFetched = false
    expect(peek('anything')).toEqual({ status: 'resolving' })
  })
})
