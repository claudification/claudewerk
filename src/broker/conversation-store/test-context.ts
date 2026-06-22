import type { Conversation } from '../../shared/protocol'
import { NotificationDebouncer } from '../notification-debounce'
import type { StoreDriver } from '../store/types'
import { TRANSCRIPT_KICK_DEBOUNCE_MS } from './constants'
import type { ConversationStoreContext } from './event-context'

/**
 * Build a ConversationStoreContext for unit tests with all-empty collections and
 * no-op behaviors. Pass `overrides` to wire a real store, a registered
 * conversation, or spy callbacks. Shared so handler tests don't each re-declare
 * the (large) context literal.
 */
export function makeTestContext(overrides: Partial<ConversationStoreContext> = {}): ConversationStoreContext {
  return {
    conversations: new Map<string, Conversation>(),
    conversationSockets: new Map(),
    transcriptCache: new Map(),
    transcriptSeqCounters: new Map(),
    subagentTranscriptCache: new Map(),
    subagentTranscriptSeqCounters: new Map(),
    dirtyTranscripts: new Set(),
    processedClipboardIds: new Set(),
    pendingAgentLaunches: new Map(),
    transcriptKickDebouncer: new NotificationDebouncer({ windowMs: TRANSCRIPT_KICK_DEBOUNCE_MS }),
    notifiedMentions: new Set(),
    store: undefined,
    scheduleConversationUpdate: () => {},
    broadcastToChannel: () => {},
    broadcastConversationScoped: () => {},
    addTranscriptEntries: () => {},
    addSubagentTranscriptEntries: () => {},
    ...overrides,
  }
}

/** A registered conversation + store-backed context, the common handler-test
 *  setup. Returns the conversation so the test can assert on its fields. */
export function makeStoreBackedContext(
  store: StoreDriver,
  conversationId: string,
  conv: Conversation,
): ConversationStoreContext {
  return makeTestContext({ store, conversations: new Map([[conversationId, conv]]) })
}
