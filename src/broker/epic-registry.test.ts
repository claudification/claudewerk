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

/** The registry is keyed by PROJECT IDENTITY, not by the exact string the caller
 *  happened to spell. `start` is reached from an MCP call typing
 *  `claude:///path`, while the store and every canonical writer say
 *  `claude://default/path` -- keying on the raw string made an armed run
 *  invisible to a differently-spelled `isArmed`. */
describe('the armed-epic registry is spelling-blind', () => {
  const TYPED = 'claude:///Users/jonas/projects/remote-claude'
  const SCARRED = 'claude:////Users/jonas/projects/remote-claude/'
  const CANONICAL = 'claude://default/Users/jonas/projects/remote-claude'

  test('isArmed matches an equivalent but differently-normalized URI', () => {
    noteArmedEpic(TYPED, 'e1')
    expect(isArmed(CANONICAL, 'e1')).toBe(true)
    expect(isArmed(SCARRED, 'e1')).toBe(true)
  })

  test('arming twice under two spellings is ONE entry', () => {
    noteArmedEpic(TYPED, 'e1')
    noteArmedEpic(CANONICAL, 'e1')
    expect(listArmedEpics()).toHaveLength(1)
  })

  test('forgetting under a different spelling still forgets', () => {
    noteArmedEpic(TYPED, 'e1')
    forgetArmedEpic(CANONICAL, 'e1')
    expect(isArmed(TYPED, 'e1')).toBe(false)
  })

  test('the stored project stays the RAW URI the caller armed with', () => {
    noteArmedEpic(TYPED, 'e1')
    expect(listArmedEpics()).toEqual([{ project: TYPED, epicId: 'e1' }])
  })

  test('two genuinely different projects are still two entries', () => {
    noteArmedEpic(TYPED, 'e1')
    noteArmedEpic('claude:///Users/jonas/projects/elsewhere', 'e1')
    expect(listArmedEpics()).toHaveLength(2)
  })
})
