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
  if (typeof data.model === 'string') {
    conv.model = data.model
  }
  conv.lastError = undefined
}
