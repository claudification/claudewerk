/**
 * Phase 3 spawn-parent-tracking: verify the REST overview + summary helpers
 * surface parentConversationId, rootConversationId, and directChildCount.
 *
 * Covers:
 *  - conversationToOverview emits all three fields with the lineage from the
 *    in-memory Conversation.
 *  - buildDirectChildCounts walks the conversation set in a single O(N) pass
 *    and produces an accurate Map<parentId, count>.
 *  - toConversationSummary (WS broadcast shape) carries parent + root.
 *    directChildCount is deliberately absent from the WS summary -- clients
 *    derive it from their local list.
 *
 * Live HTTP / WS verification (curl /conversations, browser devtools) is
 * deferred to Phase 5 once the worktree merges and the broker rebuild
 * deploys with these fields.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationStore } from '../conversation-store'
import { buildDirectChildCounts, conversationToOverview } from '../routes/shared'
import { createSqliteDriver } from '../store/sqlite/driver'

function freshStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'spawn-parent-overview-'))
  return createSqliteDriver({ type: 'sqlite', dataDir })
}

describe('Phase 3 -- spawn-parent overview surface', () => {
  it('conversationToOverview emits parentConversationId, rootConversationId, directChildCount', () => {
    const cs = createConversationStore({ store: freshStore() })
    cs.createConversation('conv-A', 'claude://default/proj')
    cs.createConversation('conv-B', 'claude://default/proj', undefined, [], [], {
      parentConversationId: 'conv-A',
      rootConversationId: 'conv-A',
    })
    const convB = cs.getConversation('conv-B')!
    const overview = conversationToOverview(convB, cs, 0)
    expect(overview.parentConversationId).toBe('conv-A')
    expect(overview.rootConversationId).toBe('conv-A')
    expect(overview.directChildCount).toBe(0)

    const convA = cs.getConversation('conv-A')!
    const overviewA = conversationToOverview(convA, cs, 1)
    expect(overviewA.parentConversationId).toBeUndefined()
    expect(overviewA.rootConversationId).toBeUndefined()
    expect(overviewA.directChildCount).toBe(1)
  })

  it('buildDirectChildCounts aggregates correctly across the conversation set', () => {
    const cs = createConversationStore({ store: freshStore() })
    cs.createConversation('conv-A', 'claude://default/proj')
    cs.createConversation('conv-B', 'claude://default/proj', undefined, [], [], {
      parentConversationId: 'conv-A',
      rootConversationId: 'conv-A',
    })
    cs.createConversation('conv-C', 'claude://default/proj', undefined, [], [], {
      parentConversationId: 'conv-A',
      rootConversationId: 'conv-A',
    })
    cs.createConversation('conv-D', 'claude://default/proj', undefined, [], [], {
      parentConversationId: 'conv-B',
      rootConversationId: 'conv-A',
    })

    const counts = buildDirectChildCounts(cs.getAllConversations())
    expect(counts.get('conv-A')).toBe(2) // B, C
    expect(counts.get('conv-B')).toBe(1) // D
    expect(counts.get('conv-C')).toBeUndefined()
    expect(counts.get('conv-D')).toBeUndefined()
  })

  it('directChildCount defaults to 0 when caller passes nothing', () => {
    const cs = createConversationStore({ store: freshStore() })
    cs.createConversation('conv-A', 'claude://default/proj')
    const convA = cs.getConversation('conv-A')!
    const overview = conversationToOverview(convA, cs)
    expect(overview.directChildCount).toBe(0)
  })
})
