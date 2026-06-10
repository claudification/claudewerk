/**
 * Tests for the rename-critical navigation logic in use-conversations.ts:
 * the `processHash` hash router and `selectConversation`.
 *
 * A notification deep-link bug previously shipped through this path because
 * it was undertested. These tests pin the routing behaviour, including the
 * legacy `session/<id>` hash form that must still resolve after the
 * session -> conversation rename.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { selectConversations } from '@/lib/slim-conversation'
import type { Conversation } from '@/lib/types'
import { processHash, useConversationsStore } from './use-conversations'
import { handlers } from './use-websocket-handlers'

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_test',
    project: '/home/user/project',
    status: 'idle',
    startedAt: Date.now() - 60_000,
    lastActivity: Date.now(),
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    ...overrides,
  } as Conversation
}

/** Seed the store with the minimum fields the navigation actions touch. */
function seedStore(conversations: Conversation[]) {
  const conversationsById: Record<string, Conversation> = {}
  for (const c of conversations) conversationsById[c.id] = c
  useConversationsStore.setState({
    conversationsById,
    selectedConversationId: null,
    selectedProjectUri: null,
    selectedSubagentId: null,
    conversationMru: [],
    events: {},
    transcripts: {},
    showTerminal: false,
    terminalWrapperId: null,
    requestedTab: null,
    requestedTabSeq: 0,
  })
}

function setHash(value: string) {
  window.location.hash = value
}

describe('processHash', () => {
  beforeEach(() => {
    seedStore([])
    setHash('')
  })

  afterEach(() => {
    setHash('')
  })

  it('does nothing for an empty hash', () => {
    setHash('')
    processHash()
    expect(useConversationsStore.getState().selectedConversationId).toBeNull()
  })

  it('does nothing when the id segment is missing', () => {
    setHash('#conversation/')
    processHash()
    expect(useConversationsStore.getState().selectedConversationId).toBeNull()
  })

  it('routes conversation/<id> to selectConversation', () => {
    setHash('#conversation/conv_abc')
    processHash()
    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_abc')
  })

  it('routes the legacy session/<id> form to selectConversation', () => {
    // Old bookmarks / tabs created before the session -> conversation rename
    // must still resolve.
    setHash('#session/conv_legacy')
    processHash()
    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_legacy')
  })

  it('routes project/<uri> to selectProject and decodes the uri', () => {
    setHash(`#project/${encodeURIComponent('claude:///home/user/proj')}`)
    processHash()
    const state = useConversationsStore.getState()
    expect(state.selectedProjectUri).toBe('claude:///home/user/proj')
    expect(state.selectedConversationId).toBeNull()
  })

  it('routes terminal/<id> to openTerminal and opens the terminal panel', () => {
    // openTerminal resolves the owning conversation by connectionIds.
    seedStore([makeConversation({ id: 'conv_owner', connectionIds: ['conn_term'] })])
    setHash('#terminal/conn_term')
    processHash()
    const state = useConversationsStore.getState()
    expect(state.showTerminal).toBe(true)
    expect(state.terminalWrapperId).toBe('conn_term')
    expect(state.selectedConversationId).toBe('conv_owner')
  })

  it('routes task/<id> by dispatching an open-project-task event', () => {
    let received: string | null = null
    const handler = (e: Event) => {
      received = (e as CustomEvent).detail?.taskId ?? null
    }
    window.addEventListener('open-project-task', handler)
    setHash('#task/task_42')
    processHash()
    window.removeEventListener('open-project-task', handler)
    expect(received).toBe('task_42')
  })

  it('ignores an unknown mode', () => {
    setHash('#bogus/whatever')
    processHash()
    const state = useConversationsStore.getState()
    expect(state.selectedConversationId).toBeNull()
    expect(state.selectedProjectUri).toBeNull()
  })
})

describe('selectConversation', () => {
  beforeEach(() => {
    seedStore([makeConversation({ id: 'conv_a' }), makeConversation({ id: 'conv_b' })])
    setHash('')
  })

  afterEach(() => {
    setHash('')
  })

  it('updates the selected id and writes the conversation hash', () => {
    useConversationsStore.getState().selectConversation('conv_a', 'test')
    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_a')
    expect(window.location.hash).toBe('#conversation/conv_a')
  })

  it('clears the hash when deselecting', () => {
    useConversationsStore.getState().selectConversation('conv_a', 'test')
    useConversationsStore.getState().selectConversation(null, 'test')
    expect(useConversationsStore.getState().selectedConversationId).toBeNull()
    expect(window.location.hash).toBe('')
  })

  it('pushes the selected id onto the MRU list, most-recent first', () => {
    useConversationsStore.getState().selectConversation('conv_a', 'test')
    useConversationsStore.getState().selectConversation('conv_b', 'test')
    expect(useConversationsStore.getState().conversationMru).toEqual(['conv_b', 'conv_a'])
  })

  it('clears the project selection when a conversation is selected', () => {
    useConversationsStore.setState({ selectedProjectUri: 'claude:///some/project' })
    useConversationsStore.getState().selectConversation('conv_a', 'test')
    expect(useConversationsStore.getState().selectedProjectUri).toBeNull()
  })
})

// W-H3: a `conversation_update` from ANY conversation used to rebuild the whole
// conversations[] array + conversationsById index. Now conversationsById is the
// source of truth and a single update patches ONE key. These tests pin that the
// untouched conversations keep IDENTICAL object references (so per-conversation
// list-row subscribers do NOT re-render on a fleet-wide status/cost/heartbeat
// burst) and that the derived array recomputes only when the index changes.
describe('handleConversationUpdate -- single-key patch (W-H3)', () => {
  const FLEET = 20

  function rawSummary(id: string, status: Conversation['status']): Record<string, unknown> {
    return { id, project: '/home/user/project', status, startedAt: 0, lastActivity: 0, eventCount: 0 }
  }

  beforeEach(() => {
    const convs = Array.from({ length: FLEET }, (_, i) =>
      makeConversation({ id: `conv_${i}`, status: 'idle', lastActivity: 0 }),
    )
    useConversationsStore.getState().setConversations(convs)
  })

  it('updates one conversation while preserving every other reference', () => {
    const before = useConversationsStore.getState().conversationsById
    const beforeArr = selectConversations(before)

    handlers.conversation_update({
      type: 'conversation_update',
      conversationId: 'conv_5',
      conversation: rawSummary('conv_5', 'active') as never,
    })

    const after = useConversationsStore.getState().conversationsById
    // index object changed (so subscribers to the derived array see the update)...
    expect(after).not.toBe(before)
    // ...the touched conversation is a new object with the new status...
    expect(after.conv_5).not.toBe(before.conv_5)
    expect(after.conv_5.status).toBe('active')
    // ...but every OTHER conversation keeps its exact prior reference (no churn).
    for (let i = 0; i < FLEET; i++) {
      if (i === 5) continue
      expect(after[`conv_${i}`]).toBe(before[`conv_${i}`])
    }
    // derived array recomputes once (new ref) and still holds the full fleet.
    const afterArr = selectConversations(after)
    expect(afterArr).not.toBe(beforeArr)
    expect(afterArr).toHaveLength(FLEET)
  })

  it('a burst of single-conversation updates never resurrects a removed conversation or dupes', () => {
    for (let i = 0; i < FLEET; i++) {
      handlers.conversation_update({
        type: 'conversation_update',
        conversationId: `conv_${i}`,
        conversation: rawSummary(`conv_${i}`, 'active') as never,
      })
    }
    const arr = selectConversations(useConversationsStore.getState().conversationsById)
    expect(arr).toHaveLength(FLEET)
    expect(new Set(arr.map(c => c.id)).size).toBe(FLEET)
    expect(arr.every(c => c.status === 'active')).toBe(true)
  })
})
