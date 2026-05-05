import type { Conversation, HookEventOf, TranscriptEntry } from '../../../shared/protocol'
import type { ConversationStoreContext } from '../event-context'

/**
 * Track compaction state and inject synthetic transcript markers.
 * PreCompact -> compacting=true + 'compacting' marker.
 * PostCompact (or SessionStart fallback for CC < 2.1.76) -> compacting=false
 * + 'compacted' marker. PostCompact was added in CC 2.1.76 as the definitive
 * completion signal; older CC versions fire SessionStart after PreCompact
 * instead.
 */
export function handleCompactEvent(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEventOf<'PreCompact' | 'PostCompact' | 'SessionStart'>,
): void {
  if (event.hookEvent === 'PreCompact') {
    conv.compacting = true
    emitCompactionMarker(ctx, conversationId, 'compacting')
    return
  }

  if (event.hookEvent === 'PostCompact' && conv.compacting) {
    conv.compacting = false
    conv.compactedAt = Date.now()
    emitCompactionMarker(ctx, conversationId, 'compacted')
    return
  }

  // SessionStart fallback for CC < 2.1.76: SessionStart after PreCompact
  // means compaction completed
  if (event.hookEvent === 'SessionStart' && conv.compacting) {
    conv.compacting = false
    conv.compactedAt = Date.now()
    emitCompactionMarker(ctx, conversationId, 'compacted')
  }
}

function emitCompactionMarker(
  ctx: ConversationStoreContext,
  conversationId: string,
  type: 'compacting' | 'compacted',
): void {
  const marker: TranscriptEntry = { type, timestamp: new Date().toISOString() }
  ctx.addTranscriptEntries(conversationId, [marker], false)
  ctx.broadcastToChannel('conversation:transcript', conversationId, {
    type: 'transcript_entries',
    conversationId,
    entries: [marker],
    isInitial: false,
  })
}
