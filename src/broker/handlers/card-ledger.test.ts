/**
 * Ingest only. The handler records and hands off; it must NOT put the moves on
 * a panel-facing frame -- the ring is GLOBAL and a viewer's grants are
 * per-project, so the wall channel owns that filter and this module owes it no
 * second path. `broadcastScoped` staying at zero calls is the assertion that
 * keeps the retired fan-out retired.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { CardMove } from '../../shared/protocol'
import type { WallFrame } from '../../shared/wall'
import { cardLedgerSize, clearCardLedger } from '../card-ledger-ring'
import { GuardError, type HandlerContext, type MessageData } from '../handler-context'
import { wallHub } from '../wall'
import { __testing } from './card-ledger'

const { cardChanged } = __testing

function move(id: string, project = 'claude://default/repo'): CardMove {
  return { id, project, title: id, from: 'open', to: 'done', ts: 1 }
}

interface Recorder {
  ctx: HandlerContext
  replies: Record<string, unknown>[]
  scoped: { msg: Record<string, unknown>; project: string }[]
  logs: string[]
}

/** A context that records instead of sending. Both send seams are recorded even
 *  though the handler must use neither -- an assertion that they stay empty is
 *  only worth something if using them would have shown up here. */
function fakeCtx(): Recorder {
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
    requirePermission: () => {
      throw new GuardError('card-ledger ingest must never ask a permission question')
    },
  } as unknown as HandlerContext
  return { ctx, replies, scoped, logs }
}

describe('card_changed ingest', () => {
  beforeEach(() => {
    clearCardLedger()
  })

  it('records the moves and puts nothing on a panel-facing frame', () => {
    const r = fakeCtx()

    cardChanged(r.ctx, { type: 'card_changed', project: 'claude://default/repo', moves: [move('a')] } as MessageData)

    expect(cardLedgerSize()).toBe(1)
    // The retired fan-out. THE WALL's channel carries these rows now and filters
    // them per subscriber on flush; a second push path would be a second
    // disclosure rule to keep in sync with it.
    expect(r.scoped).toEqual([])
    expect(r.replies).toEqual([])
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

/**
 * The one live consumer. Deleting the broadcast leaves `publishWallCardMoves` as
 * the ONLY thing this handler hands its moves to, and nothing else in the suite
 * covers that call -- the wall-channel integration test starts one level below
 * it, at `publishWallCardMoves` itself. Without this, dropping that line too
 * would have kept every test green and silently emptied the wall's card pane.
 */
describe('card_changed -> THE WALL', () => {
  const frames: WallFrame[] = []
  const socket = {
    send: (data: string) => {
      frames.push(JSON.parse(data) as WallFrame)
      return 1
    },
  }

  beforeEach(() => {
    clearCardLedger()
    wallHub.reset()
    frames.length = 0
  })

  afterEach(() => {
    wallHub.reset()
    clearCardLedger()
  })

  it('hands the moves to the wall channel, which flushes them on the next frame', () => {
    wallHub.subscribe(socket)
    frames.length = 0

    cardChanged(fakeCtx().ctx, {
      type: 'card_changed',
      project: 'claude://default/repo',
      moves: [move('a'), move('b')],
    } as MessageData)
    wallHub.tick()

    expect(frames.at(-1)?.cards?.map(c => c.id)).toEqual(['b', 'a'])
  })
})
