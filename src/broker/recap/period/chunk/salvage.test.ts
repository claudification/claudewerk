import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMapOutput } from './map-prompt'
import { describeSalvage, salvageMapOutput } from './salvage'

/** The actual response that cost recap_zquf15w44ufh a conversation on
 *  2026-07-28 -- complete (finish_reason=stop), valid in every key except
 *  `dead_ends`, and rejected wholesale by JSON.parse. */
const INCIDENT = readFileSync(join(import.meta.dir, '__fixtures__', 'malformed-map-dead-ends.txt'), 'utf8')

describe('salvageMapOutput -- the incident fixture', () => {
  test('the fixture really is unparseable (guards the premise)', () => {
    expect(() => JSON.parse(INCIDENT)).toThrow()
    expect(() => parseMapOutput(INCIDENT)).toThrow()
  })

  test('recovers every key except the malformed one', () => {
    const r = salvageMapOutput(INCIDENT)
    expect(r.metadata.goals).toHaveLength(3)
    expect(r.metadata.discoveries).toHaveLength(5)
    expect(r.metadata.open_questions).toHaveLength(3)
    expect(r.metadata.keywords).toContain('AWS SES')
    expect(r.metadata.stakeholders).toEqual(['jonas'])
    expect(r.metadata.hashtags).toHaveLength(5)
    // The two keys that follow the malformed array are the whole point: a
    // depth-aware scan keeps reading past the break instead of giving up.
    expect(r.metadata.gotchas).toHaveLength(1)
    expect(r.metadata.gotchas[0]?.title).toBe('AWS Support API inaccessible for case lookup')
    expect(r.metadata.frustrations).toHaveLength(2)
    expect(r.metadata.frustrations[0]?.conversations).toEqual(['488cbece-b42'])
  })

  test('reports the malformed key as a loss instead of hiding it', () => {
    const r = salvageMapOutput(INCIDENT)
    expect(r.metadata.dead_ends).toHaveLength(0)
    const deadEnds = r.keys.find(k => k.key === 'dead_ends')
    expect(deadEnds?.kept).toBe(0)
    expect(deadEnds?.dropped).toBeGreaterThan(0)
    expect(r.dropped).toBeGreaterThan(0)
    expect(describeSalvage(r)).toContain('dead_ends')
  })

  test('recovers enough to be worth keeping', () => {
    const r = salvageMapOutput(INCIDENT)
    // 29 of 32 items in the original response. Dropping all of it (the old
    // behaviour) is what made the recap partial.
    expect(r.recovered).toBeGreaterThanOrEqual(20)
  })
})

describe('salvageMapOutput -- shapes', () => {
  test('a well-formed object round-trips identically to parseMapOutput', () => {
    const good = JSON.stringify({
      keywords: ['a', 'b'],
      goals: ['ship it'],
      features: [{ title: 'F', detail: 'd', conversations: ['abc'] }],
      bugs: [],
    })
    expect(salvageMapOutput(good).metadata).toEqual(parseMapOutput(good))
    expect(salvageMapOutput(good).dropped).toBe(0)
  })

  test('truncation mid-array keeps every complete element before the cut', () => {
    const truncated = '{"keywords":["one","two","thr'
    const r = salvageMapOutput(truncated)
    expect(r.metadata.keywords).toEqual(['one', 'two'])
    expect(r.keys.find(k => k.key === 'keywords')?.dropped).toBe(1)
  })

  test('truncation mid-object keeps the complete items before the cut', () => {
    const truncated = '{"bugs":[{"title":"A"},{"title":"B"},{"title":"C","det'
    expect(salvageMapOutput(truncated).metadata.bugs.map(b => b.title)).toEqual(['A', 'B'])
  })

  test('a key whose value is unreadable does not stop later keys', () => {
    const r = salvageMapOutput('{"goals":not-json,"bugs":[{"title":"B"}]}')
    expect(r.metadata.bugs).toHaveLength(1)
  })

  test('a colon inside a title is not read as a key separator', () => {
    const r = salvageMapOutput('{"bugs":[{"title":"fix: the thing","detail":"a\\"b"}],"goals":["g"]}')
    expect(r.metadata.bugs[0]?.title).toBe('fix: the thing')
    expect(r.metadata.goals).toEqual(['g'])
  })

  test('a nested key name is not mistaken for a top-level key', () => {
    // `conversations` is nested; `keywords` is real. A naive indexOf scan would
    // read the nested one and mis-slice the object.
    const r = salvageMapOutput('{"bugs":[{"title":"B","conversations":["x"]}],"keywords":["k"]}')
    expect(r.metadata.keywords).toEqual(['k'])
    expect(r.metadata.bugs[0]?.conversations).toEqual(['x'])
  })

  test('unknown keys are ignored, not counted as losses', () => {
    const r = salvageMapOutput('{"subtitle":"hi","invented":[1,2],"goals":["g"]}')
    expect(r.dropped).toBe(0)
    expect(r.keys.map(k => k.key)).toEqual(['goals'])
  })

  test('nothing recoverable comes back empty rather than throwing', () => {
    const r = salvageMapOutput('I am terribly sorry, I cannot help with that.')
    expect(r.recovered).toBe(0)
    expect(r.metadata.goals).toEqual([])
  })

  test('an empty string is safe', () => {
    expect(salvageMapOutput('').recovered).toBe(0)
  })

  test('a wrong-shaped element is dropped and reported', () => {
    // The incident in miniature: a bare string where an Item was specified.
    const r = salvageMapOutput('{"dead_ends":["a bare string",{"title":"real"}]}')
    expect(r.metadata.dead_ends).toHaveLength(1)
    expect(r.keys.find(k => k.key === 'dead_ends')).toEqual({ key: 'dead_ends', kept: 1, dropped: 1 })
  })
})
