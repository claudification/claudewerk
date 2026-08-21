/**
 * The OUTLOOK dry run: the pane's payload is the scanner's own answer, refusals
 * included, and nothing is dispatched to produce it.
 *
 * Every dep is injected, so these are facts about the payload rather than about
 * a mock of the broker: no store, no sentinel, no board.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_NIGHTSHIFT_CONFIG, NIGHTSHIFT_TAG, type NightshiftConfig } from '../../shared/nightshift-types'
import type { ProjectTask, ProjectTaskMeta } from '../../shared/project-task-types'
import type { Conversation } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import {
  configureNightshiftOutlookIo,
  nightshiftOutlook,
  type OutlookDeps,
  outlookForProject,
  resetNightshiftOutlookIo,
} from './nightshift-outlook'

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

/** An epic seat -- the only conversation shape that names the card it is on. */
function seat(cardId: string): Conversation {
  return {
    id: `conv-${cardId}`,
    project: 'claude://s/p',
    status: 'active',
    launchConfig: { epic: { cardId } },
  } as Conversation
}

function deps(cards: ProjectTaskMeta[], over: Partial<OutlookDeps> = {}): OutlookDeps {
  const bySlug = new Map(cards.map(c => [c.slug, c]))
  return {
    getAllConversations: () => [],
    isLive: () => true,
    log: () => {},
    now: () => Date.parse('2026-08-21T22:00:00Z'),
    project: 'claude://s/p',
    listCards: async () => cards,
    readCard: async slug => {
      const meta = bySlug.get(slug)
      return meta ? full(meta) : null
    },
    totalTasks: 8,
    ...over,
  }
}

describe("outlook -- one selection, the run's own", () => {
  test("admits the tagged cards the run would open with, in the run's order", async () => {
    const out = await nightshiftOutlook(deps([card('low', { priority: 'low' }), card('high', { priority: 'high' })]))
    expect(out.admitted.map(t => t.boardRef)).toEqual(['high', 'low'])
    expect(out.selected).toEqual(['high', 'low'])
    expect(out.refused).toEqual([])
  })

  test('an untagged card is not in the payload at all', async () => {
    const out = await nightshiftOutlook(deps([card('a'), card('b', { tags: ['chore'] })]))
    expect(out.selected).toEqual(['a'])
  })

  test('the task carries the card body, read at scan time', async () => {
    const out = await nightshiftOutlook(deps([card('a')]))
    expect(out.admitted[0].body).toBe('body of a')
  })
})

describe('outlook -- the refusals are the point', () => {
  test('a closed lane, a live conversation and an unreadable card each land in their bucket', async () => {
    const cards = [card('done-card', { status: 'done' }), card('busy'), card('ghost')]
    const out = await nightshiftOutlook(
      deps(cards, {
        getAllConversations: () => [seat('busy')],
        readCard: async slug => (slug === 'ghost' ? null : full(card(slug))),
      }),
    )
    const byUnit = new Map(out.refused.map(r => [r.unit, r.bucket]))
    expect(byUnit.get('done-card')).toBe('closed-lane')
    expect(byUnit.get('busy')).toBe('live-conversation')
    expect(byUnit.get('ghost')).toBe('unreadable')
    expect(out.admitted).toEqual([])
  })

  test('cards a cap pushes out are COUNTABLE, not silently sliced away', async () => {
    const out = await nightshiftOutlook(deps([card('a'), card('b'), card('c')], { totalTasks: 2 }))
    expect(out.admitted).toHaveLength(2)
    expect(out.refused).toEqual([{ unit: 'c', bucket: 'over-cap', detail: 'run opens with at most 2 task(s)' }])
    expect(out.totalTasks).toBe(2)
  })

  test('every selected card is either admitted or refused -- no silent drop', async () => {
    const out = await nightshiftOutlook(
      deps([card('a'), card('b', { status: 'archived' }), card('c')], { totalTasks: 1 }),
    )
    const covered = [...out.admitted.map(t => t.boardRef), ...out.refused.map(r => r.unit)]
    expect([...covered].sort()).toEqual([...out.selected].sort())
  })
})

describe('outlook -- what the pane needs to render honestly', () => {
  test("ships the scanner's own bucket vocabulary rather than a copy", async () => {
    const out = await nightshiftOutlook(deps([]))
    expect([...out.buckets].sort()).toEqual(['closed-lane', 'live-conversation', 'over-cap', 'unreadable'])
  })

  test('an empty board carries the idle reason, so the pane can say WHY it is empty', async () => {
    const out = await nightshiftOutlook(deps([]))
    expect(out.idleReason).toBe(`no cards tagged #${NIGHTSHIFT_TAG}`)
    expect(out.crashed).toBeUndefined()
  })

  test('tagged but none runnable does not read the same as nothing tagged', async () => {
    const out = await nightshiftOutlook(deps([card('a', { status: 'done' })]))
    expect(out.idleReason).toBe(`1 card(s) tagged #${NIGHTSHIFT_TAG}, none of them runnable`)
  })

  test('a board that will not answer comes back CRASHED, never as an empty list', async () => {
    const out = await nightshiftOutlook(
      deps([], {
        listCards: async () => {
          throw new Error('no sentinel connected for project')
        },
      }),
    )
    expect(out.crashed).toBe('no sentinel connected for project')
    expect(out.admitted).toEqual([])
  })
})

/**
 * The REAL wiring, with the board and the sentinel stubbed at the IO seam. The
 * scan itself is already pinned above; what these add is the part only the
 * wiring can get wrong -- reading the project's own `caps.totalTasks`, which is
 * what the `over-cap` bucket counts against.
 */
describe('outlookForProject -- the wiring', () => {
  const store = {
    getAllConversations: () => [],
    getActiveConversationCount: () => 0,
  } as unknown as ConversationStore

  afterEach(resetNightshiftOutlookIo)

  function stubIo(cards: ProjectTaskMeta[], config: NightshiftConfig | undefined) {
    const bySlug = new Map(cards.map(c => [c.slug, c]))
    configureNightshiftOutlookIo({
      callBoard: async (_store, _project, op) => {
        if (op.op === 'list') return { ok: true, tasks: cards }
        const meta = op.slug ? bySlug.get(op.slug) : undefined
        return meta ? { ok: true, task: full(meta) } : { ok: false }
      },
      sendNightshiftOp: async () => ({ type: 'nightshift_result', requestId: '', op: 'config_read', ok: true, config }),
    })
  }

  test('the cap comes from the project config, so over-cap counts against the REAL cap', async () => {
    stubIo([card('a'), card('b'), card('c')], { ...DEFAULT_NIGHTSHIFT_CONFIG, caps: { totalTasks: 2 } })
    const out = await outlookForProject(store, 'claude://s/p')
    expect(out.totalTasks).toBe(2)
    expect(out.admitted).toHaveLength(2)
    expect(out.refused.map(r => r.bucket)).toEqual(['over-cap'])
  })

  test("a project with no config falls back to the run's own default cap", async () => {
    stubIo([card('a')], undefined)
    const out = await outlookForProject(store, 'claude://s/p')
    expect(out.totalTasks).toBe(DEFAULT_NIGHTSHIFT_CONFIG.caps?.totalTasks ?? 8)
    expect(out.admitted).toHaveLength(1)
  })

  test('a board that answers with nothing is an empty outlook, never a throw', async () => {
    configureNightshiftOutlookIo({
      callBoard: async () => ({ ok: false, error: 'no sentinel connected for this project' }),
      sendNightshiftOp: async () => ({ type: 'nightshift_result', requestId: '', op: 'config_read', ok: false }),
    })
    const out = await outlookForProject(store, 'claude://s/p')
    expect(out.selected).toEqual([])
    expect(out.idleReason).toBe(`no cards tagged #${NIGHTSHIFT_TAG}`)
  })
})
