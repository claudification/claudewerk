import type { Conversation, HookEventOf } from '../../../shared/protocol'

/**
 * Track the working directory CC is currently using. session.project stays
 * pinned to the launch project URI; session.currentPath shifts as Claude
 * `cd`s around (worktrees, sub-projects).
 */
export function handleCwdChanged(session: Conversation, event: HookEventOf<'CwdChanged'>): void {
  if (typeof event.data.cwd === 'string') {
    session.currentPath = event.data.cwd
  }
}
