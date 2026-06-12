import { describe, expect, it } from 'bun:test'
import type { Conversation, TranscriptSystemEntry } from '../../../shared/protocol'
import type { ConversationStoreContext } from '../event-context'
import { handleSystemEntry } from './system-entry'

function makeConv(): Conversation {
  return {
    id: 'conv_test12345678',
    status: 'active',
    lastActivity: Date.parse('2026-06-12T10:00:00Z'),
    stats: { totalInputTokens: 0, totalOutputTokens: 0, compactionCount: 0, totalApiDurationMs: 0 },
  } as unknown as Conversation
}

function awaySummary(content: Record<string, unknown>): TranscriptSystemEntry {
  return {
    type: 'system',
    subtype: 'away_summary',
    content: JSON.stringify(content),
    timestamp: '2026-06-12T10:00:05Z',
    uuid: crypto.randomUUID(),
  }
}

describe('away_summary -> conv.recap', () => {
  it('carries the sanitized suggested name into conv.recap', () => {
    const conv = makeConv()
    const entry = awaySummary({ title: 'Fix spawn timeout', recap: 'R', name: 'Bug: Spawn Timeout!' })
    const changed = handleSystemEntry({} as ConversationStoreContext, conv.id, conv, entry, false)
    expect(changed).toBe(true)
    expect(conv.recap?.name).toBe('bug: spawn timeout')
    expect(conv.recap?.title).toBe('Fix spawn timeout')
  })

  it('leaves name undefined for legacy recaps without one', () => {
    const conv = makeConv()
    const entry = awaySummary({ title: 'T', recap: 'R' })
    handleSystemEntry({} as ConversationStoreContext, conv.id, conv, entry, false)
    expect(conv.recap?.name).toBeUndefined()
  })
})
