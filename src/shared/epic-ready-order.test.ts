import { describe, expect, test } from 'bun:test'
import { orderReady, unblockCounts } from './epic-ready-order'
import type { ProjectTaskMeta } from './project-task-types'
import type { TaskStatus } from './task-statuses'

let seq = 0
function card(slug: string, status: TaskStatus = 'open', extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  seq += 1
  return {
    slug,
    status,
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-17T10:00:00.000Z',
    mtime: seq,
    bodyPreview: '',
    ...extra,
  }
}

const slugs = (cards: readonly ProjectTaskMeta[]) => cards.map(c => c.slug)

describe('unblockCounts', () => {
  test('counts the whole transitive fan-out, not just the direct dependents', () => {
    const board = [
      card('head'),
      card('mid', 'open', { dependsOn: ['head'] }),
      card('leafA', 'open', { dependsOn: ['mid'] }),
      card('leafB', 'open', { dependsOn: ['mid'] }),
    ]
    expect(unblockCounts([board[0] as ProjectTaskMeta], board).get('head')).toBe(3)
  })

  test('a card nobody waits on scores zero', () => {
    const board = [card('lonely'), card('other')]
    expect(unblockCounts(board, board).get('lonely')).toBe(0)
  })

  /** A `done` card is not waiting on anything, so counting it would inflate the
   *  rank of a card whose dependents have all landed. */
  test('terminal dependents do not count', () => {
    const board = [
      card('head'),
      card('shipped', 'done', { dependsOn: ['head'] }),
      card('dropped', 'archived', { dependsOn: ['head'] }),
      card('live', 'open', { dependsOn: ['head'] }),
    ]
    expect(unblockCounts(board, board).get('head')).toBe(1)
  })

  /** The chain is already severed: `waitingOn` filters a `done` dependency out,
   *  so the card behind it is not blocked by `head` in any sense the fold sees. */
  test('a chain is not traversed THROUGH a terminal card', () => {
    const board = [
      card('head'),
      card('mid', 'done', { dependsOn: ['head'] }),
      card('tail', 'open', { dependsOn: ['mid'] }),
    ]
    expect(unblockCounts(board, board).get('head')).toBe(0)
  })

  /** The count is measured against the WHOLE board for the same reason
   *  `waitingOn` is -- a card can unblock work no selector picked up. */
  test('dependents outside the cohort still count', () => {
    const board = [card('head', 'open', { epic: 'e1' }), card('stranger', 'open', { dependsOn: ['head'] })]
    expect(unblockCounts([board[0] as ProjectTaskMeta], board).get('head')).toBe(1)
  })

  test('a dependency cycle terminates instead of hanging', () => {
    const board = [card('a', 'open', { dependsOn: ['b'] }), card('b', 'open', { dependsOn: ['a'] })]
    expect(unblockCounts(board, board).get('a')).toBe(1)
  })

  test('a card that names itself does not count itself', () => {
    const board = [card('self', 'open', { dependsOn: ['self'] })]
    expect(unblockCounts(board, board).get('self')).toBe(0)
  })

  test('a dependency on a card the board does not have is simply nobody', () => {
    const board = [card('orphan', 'open', { dependsOn: ['ghost'] })]
    expect(unblockCounts(board, board).get('orphan')).toBe(0)
  })
})

describe('orderReady', () => {
  test('the DAG is the primary key, above priority', () => {
    const board = [
      card('leaf', 'open', { priority: 'high' }),
      card('head', 'open', { priority: 'low' }),
      card('waiter', 'open', { dependsOn: ['head'] }),
    ]
    expect(slugs(orderReady([board[0] as ProjectTaskMeta, board[1] as ProjectTaskMeta], board))).toEqual([
      'head',
      'leaf',
    ])
  })

  test('priority breaks a tie the DAG cannot', () => {
    const board = [card('lo', 'open', { priority: 'low' }), card('hi', 'open', { priority: 'high' })]
    expect(slugs(orderReady(board, board))).toEqual(['hi', 'lo'])
  })

  test('an untriaged card ranks as medium -- neither jumping nor starving', () => {
    const board = [card('lo', 'open', { priority: 'low' }), card('none'), card('hi', 'open', { priority: 'high' })]
    expect(slugs(orderReady(board, board))).toEqual(['hi', 'none', 'lo'])
  })

  test('older work sorts first at equal rank', () => {
    const board = [
      card('newer', 'open', { created: '2026-08-20T00:00:00.000Z' }),
      card('older', 'open', { created: '2026-08-01T00:00:00.000Z' }),
    ]
    expect(slugs(orderReady(board, board))).toEqual(['older', 'newer'])
  })

  /** A malformed date must not collapse into "oldest" and win every tiebreak. */
  test('an unparseable created: sorts LAST rather than first', () => {
    const board = [card('broken', 'open', { created: 'whenever' }), card('dated')]
    expect(slugs(orderReady(board, board))).toEqual(['dated', 'broken'])
  })

  /**
   * THE ORDER IS TOTAL. Without a final term the sort falls back on the incoming
   * array, which is the board-enumeration accident this module exists to remove.
   */
  test('two otherwise identical cards order by slug, not by board order', () => {
    const board = [card('zeta'), card('alpha')]
    expect(slugs(orderReady(board, board))).toEqual(['alpha', 'zeta'])
    expect(slugs(orderReady([...board].reverse(), board))).toEqual(['alpha', 'zeta'])
  })

  test('does not mutate the array it was handed', () => {
    const board = [card('zeta'), card('alpha')]
    orderReady(board, board)
    expect(slugs(board)).toEqual(['zeta', 'alpha'])
  })

  test('an empty ready set is an empty order', () => {
    expect(orderReady([], [card('a')])).toEqual([])
  })
})
