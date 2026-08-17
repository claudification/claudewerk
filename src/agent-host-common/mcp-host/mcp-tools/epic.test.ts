import { describe, expect, test } from 'bun:test'
import { toBody } from './epic'

const base = { project: 'claude://s/p', epic_id: 'e1' }

describe('toBody', () => {
  test.each(['project', 'epic_id', 'action'])('a missing %s is refused with a message, not a request', field => {
    const args: Record<string, string> = { ...base, action: 'get' }
    delete args[field]
    expect(toBody(args)).toBe('project + epic_id + action are required')
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
})
