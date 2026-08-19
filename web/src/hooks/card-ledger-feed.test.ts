/**
 * A wall opened cold must show history, and a wall left open must show moves as
 * they happen. Those are two different code paths (a request/reply against the
 * broker's ring, and a live push) that land in the same list, so the ordering
 * where they meet is the thing worth testing.
 */

import type { CardMove } from '@shared/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  getCardLedger,
  installCardLedgerHandler,
  LEDGER_RENDER_MAX,
  resetCardLedger,
  seedCardLedger,
} from './card-ledger-feed'
import { useConversationsStore } from './use-conversations'

const PROJECT = 'claude://default/repo'

function move(id: string, ts: number): CardMove {
  return { id, project: PROJECT, title: id, from: 'open', to: 'done', ts }
}

/** A broker that answers `card_ledger_request` with `ring`. */
function installFakeWire(ring: CardMove[], onSend?: (msg: Record<string, unknown>) => void) {
  useConversationsStore.setState({
    sendWsMessage: (msg: Record<string, unknown>) => {
      onSend?.(msg)
      if (msg.type !== 'card_ledger_request') return
      const reply = { type: 'card_ledger_result', requestId: msg.requestId, ok: true, moves: ring }
      queueMicrotask(() => useConversationsStore.getState().cardLedgerHandler?.(reply))
    },
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
}

/** Push a live batch exactly as `card_changed` delivers it. */
function pushChanged(moves: CardMove[]) {
  useConversationsStore.getState().cardLedgerHandler?.({ type: 'card_changed', project: PROJECT, moves })
}

describe('card ledger feed', () => {
  beforeEach(() => {
    resetCardLedger()
  })

  it('seeds a cold surface from the broker ring', async () => {
    installFakeWire([move('c', 3), move('b', 2), move('a', 1)])

    await seedCardLedger()

    expect(getCardLedger().map(m => m.id)).toEqual(['c', 'b', 'a'])
  })

  it('puts a live push on top of the seeded history', async () => {
    installFakeWire([move('old', 1)])
    await seedCardLedger()

    pushChanged([move('fresh', 9)])

    expect(getCardLedger().map(m => m.id)).toEqual(['fresh', 'old'])
  })

  it('keeps a batch newest-first within itself', async () => {
    installFakeWire([])
    await seedCardLedger()

    pushChanged([move('first', 1), move('second', 2)])

    expect(getCardLedger().map(m => m.id)).toEqual(['second', 'first'])
  })

  it('does not re-add a move the live push already delivered mid-flight', async () => {
    const raced = move('raced', 5)
    installFakeWire([raced], msg => {
      // Arrives after the request went out, before the reply lands.
      if (msg.type === 'card_ledger_request') pushChanged([raced])
    })

    await seedCardLedger()

    expect(getCardLedger().map(m => m.id)).toEqual(['raced'])
  })

  it('requests the ring exactly once however many panes mount', async () => {
    let requests = 0
    installFakeWire([], msg => {
      if (msg.type === 'card_ledger_request') requests++
    })

    await Promise.all([seedCardLedger(), seedCardLedger()])
    await seedCardLedger()

    expect(requests).toBe(1)
  })

  it('survives a broker that never answers -- the live feed still works', async () => {
    useConversationsStore.setState({ sendWsMessage: () => {} } as unknown as ReturnType<
      typeof useConversationsStore.getState
    >)
    installCardLedgerHandler()

    pushChanged([move('live', 1)])

    expect(getCardLedger().map(m => m.id)).toEqual(['live'])
  })

  it('never renders more than the client bound', async () => {
    installFakeWire([])
    await seedCardLedger()

    pushChanged(Array.from({ length: LEDGER_RENDER_MAX + 25 }, (_, i) => move(`m${i}`, i)))

    expect(getCardLedger()).toHaveLength(LEDGER_RENDER_MAX)
    expect(getCardLedger()[0]?.id).toBe(`m${LEDGER_RENDER_MAX + 24}`)
  })
})
