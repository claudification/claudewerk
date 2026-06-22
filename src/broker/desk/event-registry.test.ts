import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearDeskEventHandlers,
  type DeskEvent,
  deskEventHandlerCount,
  emitDeskEvent,
  onDeskEvent,
} from './event-registry'

afterEach(() => clearDeskEventHandlers())

const turn = (id = 'c1'): DeskEvent => ({ kind: 'turn_complete', conversationId: id, project: 'claude://d/p', ts: 1 })

describe('event-registry', () => {
  test('delivers events to registered handlers', () => {
    const seen: DeskEvent[] = []
    onDeskEvent(e => {
      seen.push(e)
    })
    emitDeskEvent(turn())
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('turn_complete')
  })

  test('unsubscribe stops delivery', () => {
    let n = 0
    const off = onDeskEvent(() => {
      n++
    })
    emitDeskEvent(turn())
    off()
    emitDeskEvent(turn())
    expect(n).toBe(1)
  })

  test('a throwing handler never breaks the fire or starves siblings', () => {
    let reached = false
    onDeskEvent(() => {
      throw new Error('boom')
    })
    onDeskEvent(() => {
      reached = true
    })
    expect(() => emitDeskEvent(turn())).not.toThrow()
    expect(reached).toBe(true)
  })

  test('a rejected async handler is swallowed (does not throw at the fire site)', () => {
    onDeskEvent(async () => {
      throw new Error('async boom')
    })
    expect(() => emitDeskEvent(turn())).not.toThrow()
  })

  test('emit with no handlers is a cheap no-op', () => {
    expect(deskEventHandlerCount()).toBe(0)
    expect(() => emitDeskEvent(turn())).not.toThrow()
  })

  test('clear drops every handler', () => {
    onDeskEvent(() => {})
    onDeskEvent(() => {})
    expect(deskEventHandlerCount()).toBe(2)
    clearDeskEventHandlers()
    expect(deskEventHandlerCount()).toBe(0)
  })
})
