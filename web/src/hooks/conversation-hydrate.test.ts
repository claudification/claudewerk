/**
 * Regression: navigating to a conversation that is NOT in the roster.
 *
 * 1143f57b ("perf(broker): stop shipping ended conversations on load") dropped
 * every `status: 'ended'` conversation from the `conversations_list` payload --
 * 2312 of 2367 rows. Nothing taught the navigation path about that, so every
 * caller of `selectConversation` with an ended id set `selectedConversationId`
 * to an id `conversationsById` had never heard of, and ConversationDetail's
 * `if (!conversation) return null` rendered a BLANK PAGE.
 *
 * Reported via transcript search (search indexes ALL conversations, the roster
 * holds a fraction), but the same hole swallowed the command palette, the
 * notification deep-link, commit-ledger links, a reloaded `#conversation/<id>`
 * hash, and the project summary page's own "Recent" list.
 *
 * The fix is one lazy hydrate in the store, so every navigation path inherits
 * it: an unknown id is fetched from `GET /conversations/:id` and upserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/lib/types'
import { useConversationsStore } from './use-conversations'

const ENDED_ID = 'eab6ab70-7ad5-4abb-8b69-43bd0622bcbc'

function endedSummary(): Record<string, unknown> {
  return {
    id: ENDED_ID,
    project: 'claude://default/Users/jonas/projects/growing-generations/portal2',
    status: 'ended',
    title: 'bug: build-id regression',
    startedAt: 1786769852011,
    lastActivity: 1787128359292,
    eventCount: 0,
  }
}

/** A roster that knows about ONE live conversation and nothing else -- exactly
 *  the shape the broker now ships. */
function seedRosterWithoutEnded() {
  useConversationsStore.setState({
    conversationsById: {
      conv_live: { id: 'conv_live', project: 'claude:///p', status: 'idle' } as Conversation,
    },
    selectedConversationId: null,
    conversationMru: [],
    events: {},
    transcripts: {},
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  seedRosterWithoutEnded()
  window.location.hash = ''
  fetchMock = vi.fn(async (url: string) => {
    if (url === `/conversations/${ENDED_ID}`) {
      return { ok: true, json: async () => endedSummary() } as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('selecting a conversation the roster does not carry', () => {
  it('fetches it so the detail view has something to render', async () => {
    useConversationsStore.getState().selectConversation(ENDED_ID, 'transcript-search')

    expect(useConversationsStore.getState().selectedConversationId).toBe(ENDED_ID)
    await vi.waitFor(() => {
      expect(useConversationsStore.getState().conversationsById[ENDED_ID]).toBeDefined()
    })
    const hydrated = useConversationsStore.getState().conversationsById[ENDED_ID]
    expect(hydrated.status).toBe('ended')
    expect(hydrated.title).toBe('bug: build-id regression')
    expect(fetchMock).toHaveBeenCalledWith(`/conversations/${ENDED_ID}`, expect.anything())
  })

  it('marks the id as hydrating so the detail view can say so instead of going blank', () => {
    useConversationsStore.getState().selectConversation(ENDED_ID, 'transcript-search')
    expect(useConversationsStore.getState().hydratingConversationId).toBe(ENDED_ID)
  })

  it('does not refetch a conversation the roster already carries', () => {
    useConversationsStore.getState().selectConversation('conv_live', 'transcript-search')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useConversationsStore.getState().hydratingConversationId).toBeNull()
  })

  it('clears the hydrating flag when the conversation genuinely does not exist', async () => {
    useConversationsStore.getState().selectConversation('conv_gone', 'transcript-search')
    await vi.waitFor(() => {
      expect(useConversationsStore.getState().hydratingConversationId).toBeNull()
    })
    expect(useConversationsStore.getState().conversationsById.conv_gone).toBeUndefined()
  })

  it('reveals the workspace for a hydrated conversation, not just a rostered one', async () => {
    useConversationsStore.getState().selectConversation(ENDED_ID, 'transcript-search')
    await vi.waitFor(() => {
      expect(useConversationsStore.getState().conversationsById[ENDED_ID]).toBeDefined()
    })
    // Reveal runs on the hydrated project, so the conversation is not filtered
    // out of the workspace it was just navigated to.
    expect(useConversationsStore.getState().controlPanelPrefs.activeWorkspaceId ?? null).toBeNull()
  })
})
