/**
 * Phase 2 spawn-parent-tracking: verify parent + root persistence + SQLite
 * round-trip. Mirrors the patterns in pending-state-persistence.test.ts.
 *
 * Covers:
 *  - createConversation with lineage populates parent/root on the in-memory
 *    Conversation, the SQLite row, and a rehydrated store.
 *  - A->B->C chain: root propagates from A through C (computed at INSERT,
 *    not walked at render).
 *  - Idempotency: re-persisting a conversation never overwrites
 *    parent/root captured at first INSERT.
 *  - Best-effort: a missing parent row still records parent + root=parent.id.
 *
 * Boot-lifecycle wiring is exercised indirectly: the helper there builds the
 * lineage via getRendezvousInfo + getConversation, which is verified end-
 * to-end in Phase 5. Phase 2's unit-level concern is the persistence shape
 * + the chain-root math.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationStore } from '../conversation-store'
import { createSqliteDriver } from '../store/sqlite/driver'
import type { StoreDriver } from '../store/types'

describe('spawn-parent-tracking persistence', () => {
  let dataDir: string
  let store: StoreDriver

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'spawn-parent-'))
    store = createSqliteDriver({ type: 'sqlite', dataDir })
  })

  afterEach(() => {
    store.close()
  })

  // fallow-ignore-next-line complexity
  it('createConversation records parent + root on INSERT and round-trips through SQLite', () => {
    const cs1 = createConversationStore({ store })
    cs1.createConversation('conv-A', 'claude://default/home/user/proj')
    cs1.createConversation('conv-B', 'claude://default/home/user/proj', undefined, [], [], {
      parentConversationId: 'conv-A',
      rootConversationId: 'conv-A',
    })
    cs1.persistConversationById('conv-A')
    cs1.persistConversationById('conv-B')

    // Direct SQLite read -- column-level assertion, not just the typed view.
    const row = store.conversations.get('conv-B')
    expect(row?.parentConversationId).toBe('conv-A')
    expect(row?.rootConversationId).toBe('conv-A')

    // In-memory view.
    expect(cs1.getConversation('conv-B')?.parentConversationId).toBe('conv-A')
    expect(cs1.getConversation('conv-B')?.rootConversationId).toBe('conv-A')

    // Restart hydration: fresh store on the same driver re-reads the row.
    const cs2 = createConversationStore({ store })
    expect(cs2.getConversation('conv-B')?.parentConversationId).toBe('conv-A')
    expect(cs2.getConversation('conv-B')?.rootConversationId).toBe('conv-A')
  })

  // fallow-ignore-next-line complexity
  it('A->B->C chain: root propagates from the topmost ancestor', () => {
    const cs = createConversationStore({ store })
    cs.createConversation('conv-A', 'claude://default/proj')
    // B's parent is A (which has no root) -> root = A.id.
    const parentA = cs.getConversation('conv-A')!
    cs.createConversation('conv-B', 'claude://default/proj', undefined, [], [], {
      parentConversationId: 'conv-A',
      rootConversationId: parentA.rootConversationId ?? parentA.id,
    })
    // C's parent is B (which now has root=A) -> root = A.id.
    const parentB = cs.getConversation('conv-B')!
    cs.createConversation('conv-C', 'claude://default/proj', undefined, [], [], {
      parentConversationId: 'conv-B',
      rootConversationId: parentB.rootConversationId ?? parentB.id,
    })

    expect(cs.getConversation('conv-A')?.parentConversationId).toBeUndefined()
    expect(cs.getConversation('conv-A')?.rootConversationId).toBeUndefined()

    expect(cs.getConversation('conv-B')?.parentConversationId).toBe('conv-A')
    expect(cs.getConversation('conv-B')?.rootConversationId).toBe('conv-A')

    expect(cs.getConversation('conv-C')?.parentConversationId).toBe('conv-B')
    expect(cs.getConversation('conv-C')?.rootConversationId).toBe('conv-A')
  })

  it('re-persisting a conversation does NOT overwrite parent/root', () => {
    // Persistence path: an UPDATE branches differently than the INSERT branch.
    // The update path intentionally omits parent/root, so a revive cycle never
    // accidentally clears or rewrites the lineage. Verify with a direct SQLite
    // read after a no-op persist cycle.
    const cs1 = createConversationStore({ store })
    cs1.createConversation('conv-B', 'claude://default/proj', undefined, [], [], {
      parentConversationId: 'conv-A',
      rootConversationId: 'conv-A',
    })
    cs1.persistConversationById('conv-B')

    const conv = cs1.getConversation('conv-B')!
    // Simulate a metadata-only mutation followed by re-persist.
    conv.title = 'renamed'
    cs1.persistConversationById('conv-B')

    const rowAfter = store.conversations.get('conv-B')
    expect(rowAfter?.parentConversationId).toBe('conv-A')
    expect(rowAfter?.rootConversationId).toBe('conv-A')
  })

  it('missing parent row: still records parent + root, best-effort', () => {
    // Parent never created -- we still capture parent=callerId, root=parent.id
    // (the orphan-root UI in Phase 4 handles the missing-parent case).
    const cs = createConversationStore({ store })
    cs.createConversation('conv-orphan-child', 'claude://default/proj', undefined, [], [], {
      parentConversationId: 'never-existed',
      rootConversationId: 'never-existed',
    })
    cs.persistConversationById('conv-orphan-child')

    const row = store.conversations.get('conv-orphan-child')
    expect(row?.parentConversationId).toBe('never-existed')
    expect(row?.rootConversationId).toBe('never-existed')
  })

  it('top-level (no caller) conversation has NULL parent + root', () => {
    const cs = createConversationStore({ store })
    cs.createConversation('conv-top', 'claude://default/proj')
    cs.persistConversationById('conv-top')

    const row = store.conversations.get('conv-top')
    expect(row?.parentConversationId).toBeUndefined()
    expect(row?.rootConversationId).toBeUndefined()
  })
})
