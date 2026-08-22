import { describe, expect, test } from 'bun:test'
import { DESCRIPTION, toBody } from './epic'

const base = { project: 'claude://s/p', epic_id: 'e1' }

/**
 * A DOCUMENTATION TEST, on purpose, and only for this one sentence.
 *
 * The extend capability shipped with the first `startEpicRun` and stayed
 * invisible for months because the description did not name it -- the bug was
 * never in the code. So the words are the deliverable, and the next card to
 * rewrite this block (`runner-project-run-state` re-scopes every verb to the
 * project run) would otherwise drop them without anything going red.
 *
 * Deliberately asserts the CLAIM, not the prose: that the block says start
 * raises a ceiling on a live run and that the generation lives on the card.
 * Rephrase it freely; just do not stop saying it.
 */
describe('the description names start as the extend verb', () => {
  test('it says start raises the ceiling on a run that is already going', () => {
    expect(DESCRIPTION).toContain('START IS ALSO THE EXTEND VERB')
    expect(DESCRIPTION).toMatch(/LIVE run|mid-flight/)
    expect(DESCRIPTION).toContain('max_gens=60')
  })

  test('it points the generation counter at the card, so nobody edits run.md to move it', () => {
    expect(DESCRIPTION).toContain('overseer_gen')
    expect(DESCRIPTION).toMatch(/does NOT reset the generation counter/)
  })
})

describe('toBody', () => {
  test.each(['project', 'action'])('a missing %s is refused with a message, not a request', field => {
    const args: Record<string, string> = { ...base, action: 'get' }
    delete args[field]
    expect(toBody(args)).toBe('project + action are required')
  })

  test('a missing epic_id is refused for every action that is about ONE epic', () => {
    expect(toBody({ project: 'claude://s/p', action: 'inspect' })).toBe(
      'epic_id is required for every action except list',
    )
  })

  test('list is the exception -- it asks about the PROJECT, so it needs no epic id', () => {
    expect(toBody({ project: 'claude://s/p', action: 'list' })).toEqual({ project: 'claude://s/p', op: 'list' })
  })

  test('a get carries no start options', () => {
    expect(toBody({ ...base, action: 'get' })).toEqual({ project: 'claude://s/p', op: 'get', epicId: 'e1' })
  })

  test('a start carries the four knobs through under their wire names', () => {
    const body = toBody({ ...base, action: 'start', cadence: 'window', target: 'pr', concurrency: 2, max_gens: 9 })
    expect(body).toMatchObject({
      op: 'start',
      start: { cadence: 'window', target: 'pr', concurrency: 2, maxGens: 9 },
    })
  })

  test('start options are DROPPED for every other action -- a pause cannot smuggle a cadence', () => {
    const body = toBody({ ...base, action: 'pause', cadence: 'now', concurrency: 9 })
    expect(body).not.toHaveProperty('start')
  })

  test('an abort carries its reason, which is what lands in the baton', () => {
    expect(toBody({ ...base, action: 'abort', reason: 'scope changed' })).toMatchObject({
      op: 'abort',
      reason: 'scope changed',
    })
  })

  test('an empty reason is omitted rather than sent as an empty string', () => {
    expect(toBody({ ...base, action: 'abort', reason: '' })).not.toHaveProperty('reason')
  })

  test('break_lease carries force and reason -- the audit half is not optional', () => {
    expect(toBody({ ...base, action: 'break_lease', force: true, reason: 'werk-master died mid-turn' })).toMatchObject({
      op: 'break_lease',
      force: true,
      reason: 'werk-master died mid-turn',
    })
  })

  test('no baton knobs means NO baton query -- the engine default must survive', () => {
    expect(toBody({ ...base, action: 'get' })).not.toHaveProperty('baton')
  })

  test('baton knobs fold into one query object', () => {
    expect(toBody({ ...base, action: 'inspect', baton_limit: 200, baton_card: 't5' })).toMatchObject({
      baton: { limit: 200, cardId: 't5' },
    })
  })

  test('baton_kinds accepts the comma-separated spelling a model will actually send', () => {
    expect(toBody({ ...base, action: 'inspect', baton_kinds: 'verdict, completion' })).toMatchObject({
      baton: { kinds: ['verdict', 'completion'] },
    })
  })

  test('baton_kinds also accepts a real array', () => {
    expect(toBody({ ...base, action: 'inspect', baton_kinds: ['verdict'] })).toMatchObject({
      baton: { kinds: ['verdict'] },
    })
  })
})
