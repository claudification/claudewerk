import type { Conversation, HookEventOf } from '../../../shared/protocol'

/**
 * SessionStart: capture transcript path + model, clear stale error from
 * the previous run. Compaction-fallback for older CC versions (SessionStart
 * after PreCompact = compaction done) lives in the compact handler.
 */
export function handleSessionStart(conv: Conversation, event: HookEventOf<'SessionStart'>): void {
  const data = event.data
  if (typeof data.transcript_path === 'string') {
    conv.transcriptPath = data.transcript_path
  }
  // Model is a LAST-RESORT fallback here: the stream-json init message
  // (conversation_info, transcript.ts) and explicit set_model/reset are ground
  // truth. Only set when nothing has established the model yet -- mirrors
  // assistant-entry.ts. Defense-in-depth against an unattributed stray
  // SessionStart (e.g. a subagent compaction's SessionStart that slips past the
  // subagent-origin gate) clobbering the parent's real model.
  if (typeof data.model === 'string' && !conv.model) {
    conv.model = data.model
  }
  conv.lastError = undefined
}
