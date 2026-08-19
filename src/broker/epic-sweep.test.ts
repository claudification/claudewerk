import { describe, expect, test } from 'bun:test'
import type { EpicLaunchTag, EpicLogEntry } from '../shared/epic-run-types'
import type { Conversation } from '../shared/protocol'
import { generationMismatch, groupEpicConversations, unacknowledgedCards } from './epic-sweep'

let n = 0
function conv(tag: EpicLaunchTag | undefined, live: boolean): Conversation & { __live: boolean } {
  n += 1
  return {
    id: `conv_${n}`,
    project: 'claude://s/p',
    ...(tag ? { launchConfig: { epic: tag } } : {}),
    __live: live,
  } as unknown as Conversation & { __live: boolean }
}
const isLive = (c: Conversation) => (c as unknown as { __live: boolean }).__live

/** The tag only carries identity; liveness is the second arg to `conv()`. */
const impl = (cardId: string, gen = 1): EpicLaunchTag & never =>
  ({ epicId: 'e1', role: 'implementer', cardId, gen }) as never
const overseer = (gen = 1): EpicLaunchTag & never => ({ epicId: 'e1', role: 'overseer', gen }) as never
const verifier = (cardId: string, gen = 1): EpicLaunchTag & never =>
  ({ epicId: 'e1', role: 'verifier', cardId, gen }) as never

function entry(kind: EpicLogEntry['kind'], cardId?: string): EpicLogEntry {
  return { ts: '', kind, convId: 'c', ...(cardId ? { cardId } : {}), body: '' }
}

describe('groupEpicConversations', () => {
  test('conversations with no epic tag are ignored entirely', () => {
    expect(groupEpicConversations([conv(undefined, true)], isLive).size).toBe(0)
  })

  test('a live implementer is in flight; a dead one has settled', () => {
    const group = groupEpicConversations([conv(impl('t1'), true), conv(impl('t2'), false)], isLive).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
    expect(group?.settled).toEqual(['t2'])
  })

  test('a RETRIED card is in flight, not settled -- the dead first attempt must not settle it', () => {
    // Same card, two conversations: the crashed original and the live retry.
    const group = groupEpicConversations([conv(impl('t1'), false), conv(impl('t1'), true)], isLive).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
    expect(group?.settled).toEqual([])
  })

  test('order of conversations does not change the verdict', () => {
    const group = groupEpicConversations([conv(impl('t1'), true), conv(impl('t1'), false)], isLive).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
  })

  test('a live verifier is reported in its OWN lane, not just the combined one', () => {
    const group = groupEpicConversations([conv(verifier('t1'), true)], isLive).get('e1')
    expect(group?.inVerify).toEqual(['t1'])
    expect(group?.inFlight).toEqual(['t1'])
  })

  test('a DEAD verifier leaves the verify lane, so the card can be re-verified', () => {
    const group = groupEpicConversations([conv(verifier('t1'), false)], isLive).get('e1')
    expect(group?.inVerify).toEqual([])
    expect(group?.settled).toEqual(['t1'])
  })

  /** The lane must be role-scoped or it is just `inFlight` under another name --
   *  and an implementer keeping a card out of the verify lane would strand the
   *  verdict for as long as the implementer ran. */
  test('a live IMPLEMENTER never lands in the verify lane', () => {
    const group = groupEpicConversations([conv(impl('t1'), true)], isLive).get('e1')
    expect(group?.inVerify).toEqual([])
    expect(group?.inFlight).toEqual(['t1'])
  })

  test('a live overseer is reported; a dead one is not', () => {
    expect(groupEpicConversations([conv(overseer(), true)], isLive).get('e1')?.overseerAlive).toBe(true)
    expect(groupEpicConversations([conv(overseer(), false)], isLive).get('e1')?.overseerAlive).toBe(false)
  })

  test('the overseer never appears in inFlight -- it holds no card', () => {
    const group = groupEpicConversations([conv(overseer(), true), conv(impl('t1'), true)], isLive).get('e1')
    expect(group?.inFlight).toEqual(['t1'])
  })

  test('two epics group separately', () => {
    const other = { epicId: 'e2', role: 'implementer', cardId: 'x1', gen: 1 } as never
    const groups = groupEpicConversations([conv(impl('t1'), true), conv(other, true)], isLive)
    expect(groups.size).toBe(2)
    expect(groups.get('e2')?.inFlight).toEqual(['x1'])
  })

  test('the highest generation seen is reported for diagnostics', () => {
    const groups = groupEpicConversations([conv(impl('t1', 3), true), conv(impl('t2', 7), true)], isLive)
    expect(groups.get('e1')?.maxGenSeen).toBe(7)
  })
})

describe('unacknowledgedCards -- the standing question the wake is built on', () => {
  test('a settled card with no baton entry is unacknowledged', () => {
    expect(unacknowledgedCards(['t1'], [])).toEqual(['t1'])
  })

  test('a completion entry acknowledges it', () => {
    expect(unacknowledgedCards(['t1'], [entry('completion', 't1')])).toEqual([])
  })

  test('a verdict entry acknowledges it too', () => {
    expect(unacknowledgedCards(['t1'], [entry('verdict', 't1')])).toEqual([])
  })

  test('a DISPATCH entry does NOT acknowledge -- it records a start, not an outcome', () => {
    expect(unacknowledgedCards(['t1'], [entry('dispatch', 't1')])).toEqual(['t1'])
  })

  test('an entry for a different card does not acknowledge this one', () => {
    expect(unacknowledgedCards(['t1'], [entry('completion', 't2')])).toEqual(['t1'])
  })

  test('a cardless entry acknowledges nothing', () => {
    expect(unacknowledgedCards(['t1'], [entry('completion')])).toEqual(['t1'])
  })

  test('only the unacknowledged ones come back, in order', () => {
    const baton = [entry('completion', 't1'), entry('dispatch', 't3')]
    expect(unacknowledgedCards(['t1', 't2', 't3'], baton)).toEqual(['t2', 't3'])
  })
})

describe('generationMismatch', () => {
  const group = {
    epicId: 'e1',
    project: '',
    inFlight: [],
    inVerify: [],
    overseerAlive: false,
    liveOverseers: [],
    settled: [],
    maxGenSeen: 5,
  }

  test('agreement is silent', () => {
    expect(generationMismatch(group, 5)).toBeNull()
  })

  test('a run file behind its conversations is reported -- spawns racing the lease', () => {
    expect(generationMismatch(group, 3)).toContain('racing the lease')
  })

  test('a run file AHEAD is normal (the lease just advanced) and stays silent', () => {
    expect(generationMismatch(group, 9)).toBeNull()
  })
})
