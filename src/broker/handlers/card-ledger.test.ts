/**
 * The ring is GLOBAL and a viewer's grants are per-project, so the read path is
 * the one place a scoped guest could be handed the card titles of every board on
 * the box. That is what most of this file is about.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { CardMove } from '../../shared/protocol'
import { cardLedgerSize, clearCardLedger, recordCardMoves } from '../card-ledger-ring'
import { GuardError, type HandlerContext, type MessageData } from '../handler-context'
import { __testing } from './card-ledger'

const { cardChanged, cardLedgerRequest } = __testing

function move(id: string, project = 'claude://default/repo'): CardMove {
  return { id, project, title: id, from: 'open', to: 'done', ts: 1 }
}

/** The moves carried by a recorded frame -- reply or broadcast. */
function movesOf(frame: Record<string, unknown> | undefined): CardMove[] {
  return (frame?.moves ?? []) as CardMove[]
}

interface Recorder {
  ctx: HandlerContext
  replies: Record<string, unknown>[]
  scoped: { msg: Record<string, unknown>; project: string }[]
  logs: string[]
}

/** A context that records instead of sending. `readable` is the set of projects
 *  the caller has `chat:read` on; undefined = everything (the owner's panel). */
function fakeCtx(readable?: Set<string>): Recorder {
  const replies: Record<string, unknown>[] = []
  const scoped: { msg: Record<string, unknown>; project: string }[] = []
  const logs: string[] = []
  const ctx = {
    reply: (msg: Record<string, unknown>) => replies.push(msg),
    broadcastScoped: (msg: Record<string, unknown>, project: string) => scoped.push({ msg, project }),
    log: {
      info: (m: string) => logs.push(m),
      debug: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    },
    requirePermission: (_permission: string, project?: string) => {
      if (readable && !readable.has(project ?? '')) throw new GuardError('Permission denied')
    },
  } as unknown as HandlerContext
  return { ctx, replies, scoped, logs }
}

describe('card_changed relay', () => {
  beforeEach(() => {
    clearCardLedger()
  })

  it('records the moves and rebroadcasts them scoped to the project', () => {
    const r = fakeCtx()

    cardChanged(r.ctx, { type: 'card_changed', project: 'claude://default/repo', moves: [move('a')] } as MessageData)

    expect(cardLedgerSize()).toBe(1)
    expect(r.scoped).toHaveLength(1)
    expect(r.scoped[0]?.project).toBe('claude://default/repo')
    expect(movesOf(r.scoped[0]?.msg)[0]?.id).toBe('a')
  })

  it('logs every move with its id, its lanes and its source', () => {
    const r = fakeCtx()

    cardChanged(r.ctx, { type: 'card_changed', project: 'claude://default/repo', moves: [move('a')] } as MessageData)

    expect(r.logs.join('\n')).toContain('a: open -> done (source=sentinel, claude://default/repo)')
  })

  it('drops a frame with no project rather than recording an unattributable move', () => {
    const r = fakeCtx()

    cardChanged(r.ctx, { type: 'card_changed', moves: [move('a')] } as MessageData)

    expect(cardLedgerSize()).toBe(0)
    expect(r.scoped).toEqual([])
  })

  it('drops an empty batch', () => {
    const r = fakeCtx()

    cardChanged(r.ctx, { type: 'card_changed', project: 'claude://default/repo', moves: [] } as MessageData)

    expect(r.scoped).toEqual([])
  })
})

describe('card_ledger_request', () => {
  beforeEach(() => {
    clearCardLedger()
  })

  it('serves the ring newest first', () => {
    recordCardMoves([move('old'), move('new')])
    const r = fakeCtx()

    cardLedgerRequest(r.ctx, { type: 'card_ledger_request', requestId: 'r1' } as MessageData)

    expect(r.replies[0]).toMatchObject({ type: 'card_ledger_result', requestId: 'r1', ok: true })
    expect(movesOf(r.replies[0]).map(m => m.id)).toEqual(['new', 'old'])
  })

  it('withholds moves from projects the caller cannot read', () => {
    recordCardMoves([move('mine', 'claude://default/mine'), move('theirs', 'claude://default/theirs')])
    const r = fakeCtx(new Set(['claude://default/mine']))

    cardLedgerRequest(r.ctx, { type: 'card_ledger_request', requestId: 'r1' } as MessageData)

    expect(movesOf(r.replies[0]).map(m => m.id)).toEqual(['mine'])
  })

  it('honours a limit', () => {
    recordCardMoves([move('a'), move('b'), move('c')])
    const r = fakeCtx()

    cardLedgerRequest(r.ctx, { type: 'card_ledger_request', requestId: 'r1', limit: 2 } as MessageData)

    expect(movesOf(r.replies[0]).map(m => m.id)).toEqual(['c', 'b'])
  })

  it('ignores a junk limit instead of serving nothing', () => {
    recordCardMoves([move('a')])
    const r = fakeCtx()

    cardLedgerRequest(r.ctx, { type: 'card_ledger_request', requestId: 'r1', limit: Number.NaN } as MessageData)

    expect(movesOf(r.replies[0])).toHaveLength(1)
  })
})
