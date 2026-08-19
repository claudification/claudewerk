import { beforeEach, describe, expect, it } from 'bun:test'
import type { CardMove } from '../shared/protocol'
import { CARD_LEDGER_CAP, cardLedgerSize, clearCardLedger, readCardLedger, recordCardMoves } from './card-ledger-ring'

function move(id: string, project = 'claude://default/repo'): CardMove {
  return { id, project, title: id, from: 'open', to: 'done', ts: 1 }
}

describe('card ledger ring', () => {
  beforeEach(() => {
    clearCardLedger()
  })

  it('reads back newest first -- a ledger is read from the top', () => {
    recordCardMoves([move('first'), move('second')])
    recordCardMoves([move('third')])

    expect(readCardLedger().map(m => m.id)).toEqual(['third', 'second', 'first'])
  })

  it('never grows past the cap, dropping the oldest', () => {
    for (let i = 0; i < CARD_LEDGER_CAP + 50; i++) recordCardMoves([move(`m${i}`)])

    expect(cardLedgerSize()).toBe(CARD_LEDGER_CAP)
    const ids = readCardLedger().map(m => m.id)
    expect(ids[0]).toBe(`m${CARD_LEDGER_CAP + 49}`)
    expect(ids).not.toContain('m0')
  })

  it('drops the overflow when ONE batch is bigger than the ring', () => {
    recordCardMoves(Array.from({ length: CARD_LEDGER_CAP + 10 }, (_, i) => move(`b${i}`)))

    expect(cardLedgerSize()).toBe(CARD_LEDGER_CAP)
    expect(readCardLedger()[0]?.id).toBe(`b${CARD_LEDGER_CAP + 9}`)
  })

  it('honours a limit, and clamps one above the cap back to the cap', () => {
    for (let i = 0; i < 10; i++) recordCardMoves([move(`m${i}`)])

    expect(readCardLedger({ limit: 3 }).map(m => m.id)).toEqual(['m9', 'm8', 'm7'])
    expect(readCardLedger({ limit: 10_000 })).toHaveLength(10)
    expect(readCardLedger({ limit: 0 })).toEqual([])
  })

  it('filters to projects the caller may read', () => {
    recordCardMoves([move('mine', 'claude://default/mine'), move('theirs', 'claude://default/theirs')])

    const visible = readCardLedger({ allow: p => p === 'claude://default/mine' })

    expect(visible.map(m => m.id)).toEqual(['mine'])
  })

  it('asks the permission gate once per distinct project, not once per move', () => {
    for (let i = 0; i < 20; i++) recordCardMoves([move(`m${i}`, i % 2 ? 'claude://a' : 'claude://b')])
    const asked: string[] = []

    readCardLedger({
      allow: p => {
        asked.push(p)
        return true
      },
    })

    expect(asked.sort()).toEqual(['claude://a', 'claude://b'])
  })

  it('records nothing for an empty batch', () => {
    recordCardMoves([])

    expect(cardLedgerSize()).toBe(0)
  })
})
