import type { ServerWebSocket } from 'bun'
import type { Conversation, HookEvent, TranscriptEntry } from '../../shared/protocol'
import type { NotificationDebouncer } from '../notification-debounce'
import type { StoreDriver } from '../store/types'
import type { ControlPanelMessage } from './types'

/**
 * Shared state + behavior the addEvent / addTranscriptEntries extracted
 * functions need from the createConversationStore factory closure.
 *
 * Built once at factory construction; passed by reference to keep the
 * extracted functions stateless and unit-testable.
 */
export interface ConversationStoreContext {
  conversations: Map<string, Conversation>
  conversationSockets: Map<string, Map<string, ServerWebSocket<unknown>>>

  transcriptCache: Map<string, TranscriptEntry[]>
  transcriptSeqCounters: Map<string, number>
  subagentTranscriptCache: Map<string, TranscriptEntry[]>
  subagentTranscriptSeqCounters: Map<string, number>
  dirtyTranscripts: Set<string>
  processedClipboardIds: Set<string>
  /** Launch metadata captured at PreToolUse(Agent), FIFO-queued per conversation
   *  and consumed by the matching SubagentStart. The queue (not a single slot)
   *  handles parallel Agent launches whose SubagentStarts interleave. */
  pendingAgentLaunches: Map<string, AgentLaunchMeta[]>
  /** Once-per-window debounce for transcript_kick nudges, keyed by
   *  conversationId (window = TRANSCRIPT_KICK_DEBOUNCE_MS). */
  transcriptKickDebouncer: NotificationDebouncer
  /**
   * Hashes of mention-notifications already fired, keyed by
   * `${conversationId}:${entryUuid}:${userName}`. Prevents duplicate pushes
   * when the same assistant entry is re-ingested (reconnect, re-stream,
   * sentinel revive). Bounded by mentionNotifyCap with FIFO-ish eviction
   * inside the dispatch helper.
   */
  notifiedMentions: Set<string>

  store?: StoreDriver

  // Behavior: provided by factory because they touch other closure state
  scheduleConversationUpdate: (conversationId: string) => void
  broadcastToChannel: (
    channel: 'conversation:events' | 'conversation:transcript' | 'conversation:subagent_transcript',
    conversationId: string,
    message: unknown,
    agentId?: string,
  ) => void
  broadcastConversationScoped: (message: ControlPanelMessage, project: string) => void
  // addTranscriptEntries calls itself recursively (PreCompact/PostCompact markers).
  // Provide via context so addEvent can call it without forming a cyclic import.
  addTranscriptEntries: (conversationId: string, entries: TranscriptEntry[], isInitial: boolean) => void
  addSubagentTranscriptEntries: (
    conversationId: string,
    agentId: string,
    entries: TranscriptEntry[],
    isInitial: boolean,
  ) => void
}

/**
 * Inline-agent launch metadata, captured from the Agent tool_input at
 * PreToolUse and consumed at the matching SubagentStart. Split by SIZE: the
 * cheap fields (subagentType, model, description) enrich the roster card; the
 * big prompt + bulky args become the agent sub-stream's launch entry and are
 * NEVER broadcast on the roster (plan-agent-transcript-separation 3b).
 */
export interface AgentLaunchMeta {
  description?: string
  subagentType?: string
  model?: string
  prompt?: string
  /** Bulky launch args beyond prompt/description (isolation, team_name, ...). */
  args?: Record<string, unknown>
}

export function assignTranscriptSeqs(
  counters: Map<string, number>,
  key: string,
  entries: TranscriptEntry[],
  reset: boolean,
): void {
  if (reset) counters.set(key, 0)
  let seq = counters.get(key) ?? 0
  for (const e of entries) {
    e.seq = ++seq
  }
  counters.set(key, seq)
}

export type { HookEvent, TranscriptEntry }
