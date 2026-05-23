/**
 * Shared `launch_progress` emit helper for the spawn dispatch paths.
 *
 * Every backend's spawn path emits the same first-class `launch_progress`
 * lifecycle events (job_created / spawn_sent / agent_acked / failed / ...).
 * This is the single implementation -- the claude-daemon transport, the
 * OpenCode backend, and the inline claude path in spawn-dispatch all call it
 * (transport reframe Phase 6 de-duplication).
 */

import type { LaunchProgressEvent, LaunchStep } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'

/**
 * Emit a first-class launch_progress event to all subscribers of the job.
 * No-op if jobId is undefined (callers that dispatch without tracking a job).
 */
export function emitLaunchProgress(
  conversationStore: ConversationStore,
  jobId: string | undefined,
  step: LaunchStep,
  status: LaunchProgressEvent['status'],
  extra?: Partial<LaunchProgressEvent>,
): void {
  if (!jobId) return
  conversationStore.forwardJobEvent(jobId, { type: 'launch_progress', jobId, step, status, t: Date.now(), ...extra })
}
