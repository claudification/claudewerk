import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { isManaged, managedInfo } from './managed'

function conv(over: Partial<Conversation> = {}): Conversation {
  return { id: 'conv_1', project: 'claude:///x', status: 'active', ...over } as unknown as Conversation
}

describe('managedInfo', () => {
  it('is undefined for a conversation a human started', () => {
    expect(managedInfo(conv())).toBeUndefined()
    expect(isManaged(conv())).toBe(false)
  })

  it('marks every epic seat, whatever its role', () => {
    for (const role of ['overseer', 'implementer', 'verifier'] as const) {
      const info = managedInfo(conv({ epic: { epicId: 'ep_1', role, gen: 2 } }))
      expect(info?.kind).toBe('epic')
      expect(info?.label).toBe('OVER')
      expect(info?.role).toBe(role)
    }
  })

  it('groups epic seats by epicId, not by conversation parentage', () => {
    // Seats are spawned by the broker sweep, so there is no parent/child edge.
    const a = managedInfo(conv({ epic: { epicId: 'ep_1', role: 'implementer', cardId: 'c1', gen: 1 } }))
    const b = managedInfo(conv({ epic: { epicId: 'ep_1', role: 'verifier', cardId: 'c1', gen: 1 } }))
    expect(a?.runId).toBe('ep_1')
    expect(b?.runId).toBe('ep_1')
  })

  it('marks nightshift runs too — unattended is unattended', () => {
    const info = managedInfo(conv({ nightshift: { runId: 'run_1', taskId: 't1' } }))
    expect(info?.kind).toBe('nightshift')
    expect(info?.label).toBe('NIGHT')
    expect(info?.runId).toBe('run_1')
  })

  it('prefers the epic tag when a conversation somehow carries both', () => {
    const info = managedInfo(
      conv({ epic: { epicId: 'ep_1', role: 'overseer', gen: 1 }, nightshift: { runId: 'r', taskId: 't' } }),
    )
    expect(info?.kind).toBe('epic')
  })

  it('does NOT key off anything the conversation could write about itself', () => {
    // The trust rule: provenance comes from the dispatcher, never a self-report.
    // A liveStatus/title/agentName claiming to be an overseer proves nothing.
    const impostor = conv({
      title: '[epic ep_9] overseer',
      agentName: 'overseer',
      liveStatus: { state: 'working', seq: 1, updatedAt: 1 },
    })
    expect(isManaged(impostor)).toBe(false)
  })
})
