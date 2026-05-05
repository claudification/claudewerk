import type { Conversation, HookEventOf } from '../../../shared/protocol'

/**
 * Track the working directory CC is currently using. conv.project stays
 * pinned to the launch project URI; conv.currentPath shifts as Claude
 * `cd`s around (worktrees, sub-projects).
 */
export function handleCwdChanged(conv: Conversation, event: HookEventOf<'CwdChanged'>): void {
  if (typeof event.data.cwd === 'string') {
    conv.currentPath = event.data.cwd
  }
}
