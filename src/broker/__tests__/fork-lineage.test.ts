/**
 * A fork's parent is the conversation it FORKED FROM -- not whoever called spawn.
 *
 * `computeSpawnLineage` was written for spawn-parent-tracking, where the only
 * ancestor that exists is the caller. Forking then reused it unchanged, so
 * fork parentage was never recorded anywhere:
 *
 *   - Web fork dialog: the fold and the spawn are two separate calls, and a
 *     browser is not a conversation. callerId is undefined -> parent/root NULL.
 *     Measured on two real forks (dc921414, be88fa36): both empty.
 *   - MCP `fork_from`: an agent called spawn, so parent/root were populated --
 *     with the CALLER's id. ccb82e5e was forked from 5c221787 and recorded
 *     fe771e12, the conversation that happened to issue the spawn. It looked
 *     correct and was wrong.
 *
 * Either way the `<forked>` block in the system prompt knew the parent and the
 * database did not, so the panel could not draw the lineage.
 */

import { describe, expect, it } from 'bun:test'
import { computeSpawnLineage } from '../spawn-lineage'

type Row = { id: string; rootConversationId?: string }

/** Minimal ConversationStore stand-in -- lineage only reads getConversation. */
function storeOf(...rows: Row[]) {
  const byId = new Map(rows.map(r => [r.id, r]))
  // Typed off the function under test rather than `any`, so a change to the
  // store shape it needs shows up here instead of being cast away.
  return { getConversation: (id: string) => byId.get(id) } as unknown as Parameters<typeof computeSpawnLineage>[0]
}

const SOURCE = 'src-conversation-id'
const CALLER = 'caller-conversation-id'
const CHILD = 'child-conversation-id'

describe('computeSpawnLineage -- fork parentage', () => {
  it('records the FORK SOURCE as parent, not the spawn caller', () => {
    const lineage = computeSpawnLineage(storeOf({ id: SOURCE }, { id: CALLER }), CALLER, CHILD, 'boot', {
      forkedFromId: SOURCE,
    })

    expect(lineage?.parentConversationId).toBe(SOURCE)
  })

  it('roots the fork in the SOURCE tree, not the caller tree', () => {
    const lineage = computeSpawnLineage(
      storeOf({ id: SOURCE, rootConversationId: 'source-root' }, { id: CALLER, rootConversationId: 'caller-root' }),
      CALLER,
      CHILD,
      'boot',
      { forkedFromId: SOURCE },
    )

    expect(lineage?.rootConversationId).toBe('source-root')
  })

  it('records a fork with NO caller -- the web dialog case that produced NULLs', () => {
    // A browser is not a conversation, so callerId is undefined. Before the fix
    // this returned undefined outright and the row was written with NULL parent.
    const lineage = computeSpawnLineage(storeOf({ id: SOURCE }), undefined, CHILD, 'boot', { forkedFromId: SOURCE })

    expect(lineage?.parentConversationId).toBe(SOURCE)
    expect(lineage?.rootConversationId).toBe(SOURCE)
  })

  it('self-roots a fork whose source row is gone', () => {
    const lineage = computeSpawnLineage(storeOf(), undefined, CHILD, 'boot', { forkedFromId: SOURCE })

    expect(lineage?.parentConversationId).toBe(SOURCE)
    expect(lineage?.rootConversationId).toBe(SOURCE)
  })

  it('still uses the caller for an ORDINARY spawn', () => {
    const lineage = computeSpawnLineage(
      storeOf({ id: CALLER, rootConversationId: 'caller-root' }),
      CALLER,
      CHILD,
      'boot',
    )

    expect(lineage?.parentConversationId).toBe(CALLER)
    expect(lineage?.rootConversationId).toBe('caller-root')
  })

  it('still self-roots an ordinary spawn with no caller', () => {
    expect(computeSpawnLineage(storeOf(), undefined, CHILD, 'boot')).toBeUndefined()
  })

  it('carries notifyParentSettleMs through the options bag', () => {
    const lineage = computeSpawnLineage(storeOf({ id: CALLER }), CALLER, CHILD, 'boot', {
      notifyParentSettleMs: 20_000,
    })

    expect(lineage?.notifyParentSettleMs).toBe(20_000)
  })

  it('prefers the fork source even when the caller IS the source', () => {
    // Forking your own conversation: parent must be the source exactly once,
    // and must not self-reference the child.
    const lineage = computeSpawnLineage(storeOf({ id: SOURCE }), SOURCE, CHILD, 'boot', { forkedFromId: SOURCE })

    expect(lineage?.parentConversationId).toBe(SOURCE)
    expect(lineage?.parentConversationId).not.toBe(CHILD)
  })
})
