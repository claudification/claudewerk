import { describe, expect, it } from 'bun:test'
import {
  CONVERSATION_ROLE_RANK,
  type ConversationRole,
  classifyConversationRole,
  isEpicSeatRole,
  overseerScopeKey,
} from './conversation-role'

describe('classifyConversationRole', () => {
  it('reads the seat straight off the epic tag', () => {
    expect(classifyConversationRole({ epic: { role: 'overseer' } })).toBe('overseer')
    expect(classifyConversationRole({ epic: { role: 'implementer' } })).toBe('implementer')
    expect(classifyConversationRole({ epic: { role: 'verifier' } })).toBe('verifier')
  })

  it('is normal with no origin tag at all', () => {
    expect(classifyConversationRole({})).toBe('normal')
  })

  // The axis that must NOT collapse into role: a night task is an ordinary
  // conversation on a schedule, not a seat in a supervised run. If this ever
  // starts returning something else, the cadence axis has leaked into the seat
  // axis and the sidebar will nest night rows under nobody.
  it('leaves a night task normal -- cadence is not a seat', () => {
    expect(classifyConversationRole({} as { epic?: { role: ConversationRole } })).toBe('normal')
  })
})

describe('overseerScopeKey', () => {
  it('groups a seat by its epic today', () => {
    expect(overseerScopeKey({ epic: { role: 'implementer', epicId: 'epic-the-wall' } })).toBe('epic-the-wall')
  })

  it('returns null for a row that nests under nobody', () => {
    expect(overseerScopeKey({})).toBeNull()
  })

  // Two epics in ONE project each hold their own overseer lease today
  // (epic-beat-actions.ts leases on epicId). Until that becomes a project
  // singleton, two seats in the same project must NOT collapse into one subtree.
  it('keeps two epics in one project apart', () => {
    const a = overseerScopeKey({ epic: { role: 'implementer', epicId: 'epic-the-wall' } })
    const b = overseerScopeKey({ epic: { role: 'implementer', epicId: 'epic-the-wall-ii' } })
    expect(a).not.toBe(b)
  })
})

describe('rank', () => {
  it('sorts an overseer above its seats, and seats above ordinary rows', () => {
    const order = (['normal', 'verifier', 'implementer', 'overseer'] as ConversationRole[]).sort(
      (x, y) => CONVERSATION_ROLE_RANK[x] - CONVERSATION_ROLE_RANK[y],
    )
    expect(order).toEqual(['overseer', 'implementer', 'verifier', 'normal'])
  })

  it('ranks every role -- a new member cannot silently sort last', () => {
    const roles: ConversationRole[] = ['normal', 'implementer', 'verifier', 'overseer']
    for (const r of roles) expect(typeof CONVERSATION_ROLE_RANK[r]).toBe('number')
  })
})

describe('isEpicSeatRole', () => {
  it('counts everything that belongs inside an overseer subtree', () => {
    expect(isEpicSeatRole('overseer')).toBe(true)
    expect(isEpicSeatRole('implementer')).toBe(true)
    expect(isEpicSeatRole('verifier')).toBe(true)
    expect(isEpicSeatRole('normal')).toBe(false)
  })
})
