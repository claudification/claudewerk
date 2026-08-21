import { describe, expect, test } from 'bun:test'
import { NIGHTSHIFT_TAG } from '../../shared/nightshift-types'
import type { ProjectTask, ProjectTaskMeta } from '../../shared/project-task-types'
import type { Conversation } from '../../shared/protocol'
import { cardToNightshiftTask, type NightshiftScanDeps, nightshiftScanner } from './nightshift-scanner'
import { runScan } from './scanner'

/**
 * The nightshift scanner, exercised with no broker, no store and no sentinel --
 * the property the contract exists to give, spent here.
 *
 * Every dep is a plain function over plain objects, so each branch below is a
 * fact about the SELECTION rather than about a mock of the board.
 */

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

const full = (meta: ProjectTaskMeta, body = `body of ${meta.slug}`): ProjectTask => ({ ...meta, body })

/** An epic seat, which is how a conversation names the card it is working. */
function seat(cardId: string, status: Conversation['status'] = 'active'): Conversation {
  return { id: `conv-${cardId}`, project: 'claude://s/p', status, launchConfig: { epic: { cardId } } } as Conversation
}

function deps(cards: ProjectTaskMeta[], over: Partial<NightshiftScanDeps> = {}): NightshiftScanDeps {
  const byslug = new Map(cards.map(c => [c.slug, c]))
  return {
    getAllConversations: () => [],
    isLive: () => true,
    log: () => {},
    now: () => Date.parse('2026-08-21T22:00:00Z'),
    project: 'claude://s/p',
    listCards: async () => cards,
    readCard: async slug => {
      const meta = byslug.get(slug)
      return meta ? full(meta) : null
    },
    totalTasks: 8,
    admitted: [],
    ...over,
  }
}

describe('selection -- the tag is the list', () => {
  test('only #nightshift cards are selected; an untagged card is never even seen', async () => {
    const d = deps([card('a'), card('b', { tags: ['chore'] }), card('c', { tags: ['chore', NIGHTSHIFT_TAG] })])
    const report = await runScan(nightshiftScanner, d)

    expect(report.selected).toEqual(['a', 'c'])
    expect(report.acted).toEqual(['a', 'c'])
    expect(d.admitted.map(t => t.boardRef)).toEqual(['a', 'c'])
  })

  test('an empty board is an idle pass, not a crash', async () => {
    const d = deps([])
    const report = await runScan(nightshiftScanner, d)

    expect(report.selected).toEqual([])
    expect(report.idleReason).toBe(`no cards tagged #${NIGHTSHIFT_TAG}`)
    expect(d.admitted).toEqual([])
  })

  test('high priority first, then oldest first -- so a cap always cuts the same tail', async () => {
    const d = deps([
      card('young', { created: '2026-08-10T00:00:00Z' }),
      card('urgent', { priority: 'high', created: '2026-08-11T00:00:00Z' }),
      card('old', { created: '2026-08-02T00:00:00Z' }),
      card('later', { priority: 'low', created: '2026-08-01T00:00:00Z' }),
    ])
    const report = await runScan(nightshiftScanner, d)

    expect(report.acted).toEqual(['urgent', 'old', 'young', 'later'])
  })
})

describe('the task is built from the CARD, at dispatch time', () => {
  test('the body comes from the full read, never from the list preview', async () => {
    const meta = card('a', { bodyPreview: 'STALE PREVIEW' })
    const d = deps([meta], { readCard: async () => full(meta, 'the body as it is right now') })
    await runScan(nightshiftScanner, d)

    expect(d.admitted[0]?.body).toBe('the body as it is right now')
  })

  test('the card id lives in boardRef and the ids are run-local ordinals', async () => {
    const d = deps([card('a'), card('b')])
    await runScan(nightshiftScanner, d)

    expect(d.admitted.map(t => [t.id, t.boardRef])).toEqual([
      ['001', 'a'],
      ['002', 'b'],
    ])
    expect(d.admitted.every(t => t.source === 'board' && t.status === 'queued')).toBe(true)
  })

  test('ordinals stay contiguous when a card in the middle is refused', async () => {
    const d = deps([card('a'), card('skipme', { status: 'done' }), card('c')])
    await runScan(nightshiftScanner, d)

    expect(d.admitted.map(t => t.id)).toEqual(['001', '002'])
    expect(d.admitted.map(t => t.boardRef)).toEqual(['a', 'c'])
  })

  test('cardToNightshiftTask stamps the scan clock, not the card creation date', () => {
    const task = cardToNightshiftTask(full(card('a')), 'claude://s/p', 3, Date.parse('2026-08-21T22:00:00Z'))
    expect(task).toEqual({
      id: '003',
      title: 'card a',
      project: 'claude://s/p',
      status: 'queued',
      source: 'board',
      boardRef: 'a',
      created: '2026-08-21T22:00:00.000Z',
      body: 'body of a',
    })
  })
})

describe('every card it declines lands in a named bucket', () => {
  test('a closed lane', async () => {
    const d = deps([card('shipped', { status: 'done' }), card('gone', { status: 'archived' })])
    const report = await runScan(nightshiftScanner, d)

    // Same `created`, so the tiebreak is the slug -- `gone` before `shipped`.
    expect(report.refused.map(r => [r.unit, r.bucket])).toEqual([
      ['gone', 'closed-lane'],
      ['shipped', 'closed-lane'],
    ])
    expect(report.unaccounted).toEqual([])
  })

  test('a live conversation is already on the card', async () => {
    const d = deps([card('a')], { getAllConversations: () => [seat('a')], isLive: () => true })
    const report = await runScan(nightshiftScanner, d)

    expect(report.refused.map(r => r.bucket)).toEqual(['live-conversation'])
    expect(d.admitted).toEqual([])
  })

  test('a DEAD conversation on the card does not hold it back', async () => {
    const d = deps([card('a')], { getAllConversations: () => [seat('a', 'ended')], isLive: () => false })
    const report = await runScan(nightshiftScanner, d)

    expect(report.acted).toEqual(['a'])
  })

  test('the cap names what it pushed out -- the old slice() dropped it silently', async () => {
    const d = deps([card('a'), card('b'), card('c')], { totalTasks: 2 })
    const report = await runScan(nightshiftScanner, d)

    expect(report.acted).toEqual(['a', 'b'])
    expect(report.refused).toEqual([{ unit: 'c', bucket: 'over-cap', detail: 'run opens with at most 2 task(s)' }])
  })

  test('a card that vanished between the list and the read', async () => {
    const d = deps([card('a')], { readCard: async () => null })
    const report = await runScan(nightshiftScanner, d)

    expect(report.refused.map(r => r.bucket)).toEqual(['unreadable'])
    expect(report.acted).toEqual([])
  })

  test('acted + refused always cover the selection -- nothing is dropped silently', async () => {
    const d = deps([card('a'), card('done', { status: 'done' }), card('busy'), card('b'), card('c')], {
      totalTasks: 2,
      getAllConversations: () => [seat('busy')],
    })
    const report = await runScan(nightshiftScanner, d)

    expect(report.unaccounted).toEqual([])
    expect([...report.acted, ...report.refused.map(r => r.unit)].sort()).toEqual(['a', 'b', 'busy', 'c', 'done'])
  })

  test('every tagged card refused -> an idle reason that says how many were looked at', async () => {
    const d = deps([card('a', { status: 'done' }), card('b', { status: 'archived' })])
    const report = await runScan(nightshiftScanner, d)

    expect(report.idleReason).toBe(`2 card(s) tagged #${NIGHTSHIFT_TAG}, none of them runnable`)
  })
})

describe('self-catching, via the contract', () => {
  test('a board that will not answer is a crashed report, not a throw', async () => {
    const log: string[] = []
    const d = deps([], {
      listCards: async () => {
        throw new Error('sentinel timed out (10s)')
      },
      log: line => log.push(line),
    })
    const report = await runScan(nightshiftScanner, d)

    expect(report.crashed).toBe('sentinel timed out (10s)')
    expect(report.acted).toEqual([])
    expect(log.join('\n')).toContain('[nightshift-scan] scan crashed')
  })
})

describe('the scanner declares itself', () => {
  test('id, tag, verb and the complete bucket vocabulary', () => {
    expect(nightshiftScanner.id).toBe('nightshift')
    expect(nightshiftScanner.does).toBe('dispatch')
    expect(nightshiftScanner.selects).toBe(`#${NIGHTSHIFT_TAG}`)
    expect([...nightshiftScanner.buckets].sort()).toEqual([
      'closed-lane',
      'live-conversation',
      'over-cap',
      'unreadable',
    ])
  })
})
