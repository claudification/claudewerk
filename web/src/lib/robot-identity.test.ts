import { describe, expect, it } from 'vitest'
import { assistantRobot, robotIdentity } from './robot-identity'
import { ROBOT_ADJECTIVES, ROBOT_NOUNS } from './robot-words'

function entry(ccSessionId?: string) {
  return { type: 'assistant', ccSessionId } as unknown as Parameters<typeof assistantRobot>[0][number]
}

describe('robotIdentity', () => {
  it('is stable -- the same session id always yields the same robot', () => {
    const a = robotIdentity('8c1253e5-ad4e-48b6-ae5c-cd0c6eb149d8')
    const b = robotIdentity('8c1253e5-ad4e-48b6-ae5c-cd0c6eb149d8')
    expect(a).toEqual(b)
  })

  it('draws both words from the vocabulary', () => {
    const [adjective, noun] = robotIdentity('some-session').name.split(' ')
    expect(ROBOT_ADJECTIVES).toContain(adjective)
    expect(ROBOT_NOUNS).toContain(noun)
  })

  it('seeds the avatar with the session id verbatim, so face and name agree', () => {
    expect(robotIdentity('abc-123').seed).toBe('abc-123')
  })

  it('emits a bare 6-digit hex background (DiceBear wire format, no #)', () => {
    for (const id of ['a', 'b', 'session-1', 'session-2', crypto.randomUUID()]) {
      expect(robotIdentity(id).backgroundColor).toMatch(/^[0-9a-f]{6}$/)
    }
  })

  it('gives different sessions different robots', () => {
    // Not a uniqueness guarantee (2304 handles collide by design) -- this pins
    // that the hash actually varies rather than parking everyone on one name.
    const names = new Set(Array.from({ length: 200 }, (_, i) => robotIdentity(`session-${i}`).name))
    expect(names.size).toBeGreaterThan(150)
  })

  it('decorrelates the two word draws', () => {
    // The avalanche step exists for this: without it, sequential ids march
    // through the noun list in lockstep with the adjective list.
    const adjectives = new Set<string>()
    const nouns = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const [adjective, noun] = robotIdentity(`session-${i}`).name.split(' ')
      adjectives.add(adjective as string)
      nouns.add(noun as string)
    }
    expect(adjectives.size).toBeGreaterThan(30)
    expect(nouns.size).toBeGreaterThan(30)
  })
})

describe('assistantRobot', () => {
  it('reads the session id off the first entry that carries one', () => {
    const robot = assistantRobot([entry(undefined), entry('session-xyz')])
    expect(robot).toEqual(robotIdentity('session-xyz'))
  })

  it('returns null for history predating the session-id field', () => {
    expect(assistantRobot([entry(undefined)])).toBeNull()
    expect(assistantRobot([])).toBeNull()
  })
})
