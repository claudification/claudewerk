import { describe, expect, it } from 'vitest'
import { computeSwitchSlots, MAX_PINS } from './conversation-pins'
import type { Conversation } from './types'

function conv(id: string, status: Conversation['status'], lastActivity: number): Conversation {
  return { id, status, lastActivity } as Conversation
}

describe('computeSwitchSlots', () => {
  it('keeps pinned conversations in pin order, even when ended', () => {
    const convs = [conv('a', 'ended', 1), conv('b', 'active', 2)]
    expect(computeSwitchSlots(convs, ['b', 'a']).map(c => c.id)).toEqual(['b', 'a'])
  })

  it('drops pinned ids that no longer exist', () => {
    const convs = [conv('a', 'active', 1)]
    expect(computeSwitchSlots(convs, ['ghost', 'a']).map(c => c.id)).toEqual(['a'])
  })

  it('auto-fills empty slots with most-recently-active running conversations', () => {
    const convs = [conv('a', 'active', 10), conv('b', 'idle', 30), conv('c', 'active', 20), conv('d', 'ended', 99)]
    // no pins -> recent-active by lastActivity desc, ended excluded
    expect(computeSwitchSlots(convs, []).map(c => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('does not duplicate a pinned conversation in the auto-fill', () => {
    const convs = [conv('a', 'active', 10), conv('b', 'active', 30)]
    expect(computeSwitchSlots(convs, ['a']).map(c => c.id)).toEqual(['a', 'b'])
  })

  it('caps the total at MAX_PINS', () => {
    const convs = Array.from({ length: 12 }, (_, i) => conv(`c${i}`, 'active', i))
    expect(computeSwitchSlots(convs, []).length).toBe(MAX_PINS)
  })
})
