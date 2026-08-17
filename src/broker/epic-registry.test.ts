import { afterEach, describe, expect, test } from 'bun:test'
import { forgetArmedEpic, isArmed, listArmedEpics, noteArmedEpic, resetArmedEpics } from './epic-registry'

const P = 'claude://studio/proj'
const Q = 'claude://studio/other'

afterEach(() => resetArmedEpics())

describe('the armed-epic registry', () => {
  test('nothing is armed to start with', () => {
    expect(listArmedEpics()).toEqual([])
  })

  test('arming makes an epic visible to the sweep', () => {
    noteArmedEpic(P, 'e1')
    expect(isArmed(P, 'e1')).toBe(true)
    expect(listArmedEpics()).toEqual([{ project: P, epicId: 'e1' }])
  })

  test('arming twice is idempotent -- re-starting a run must not double it', () => {
    noteArmedEpic(P, 'e1')
    noteArmedEpic(P, 'e1')
    expect(listArmedEpics()).toHaveLength(1)
  })

  test('the same epic id in two projects is two entries', () => {
    noteArmedEpic(P, 'e1')
    noteArmedEpic(Q, 'e1')
    expect(listArmedEpics()).toHaveLength(2)
  })

  test('forgetting one project does not forget the other', () => {
    noteArmedEpic(P, 'e1')
    noteArmedEpic(Q, 'e1')
    forgetArmedEpic(P, 'e1')
    expect(isArmed(P, 'e1')).toBe(false)
    expect(isArmed(Q, 'e1')).toBe(true)
  })

  test('forgetting something never armed is a no-op, not a throw', () => {
    expect(() => forgetArmedEpic(P, 'ghost')).not.toThrow()
  })
})
