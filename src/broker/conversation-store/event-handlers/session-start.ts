import type { Conversation, HookEventOf } from '../../../shared/protocol'

/**
 * SessionStart: capture transcript path + model, clear stale error from
 * the previous run. Compaction-fallback for older CC versions (SessionStart
 * after PreCompact = compaction done) lives in the compact handler.
 */
export function handleSessionStart(session: Conversation, event: HookEventOf<'SessionStart'>): void {
  const data = event.data
  if (typeof data.transcript_path === 'string') {
    session.transcriptPath = data.transcript_path
  }
  if (typeof data.model === 'string') {
    session.model = data.model
  }
  session.lastError = undefined
}
