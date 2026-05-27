import type { Conversation, HookEventOf } from '../../../shared/protocol'

/**
 * Track the working directory CC is currently using. conv.project stays
 * pinned to the launch project URI; conv.currentPath shifts as Claude
 * `cd`s around (worktrees, sub-projects).
 */
export function handleCwdChanged(conv: Conversation, event: HookEventOf<'CwdChanged'>): void {
  if (typeof event.data.cwd === 'string') {
    conv.currentPath = event.data.cwd
    return
  }
  // TEMP diagnostic (remove after fix): CC fires CwdChanged + it reaches here, but
  // currentPath stays null fleet-wide -> data.cwd isn't a string. Capture CC's real
  // payload shape so we can read the right field. Greppable: `grep cwd-debug`.
  const data = event.data as unknown as Record<string, unknown>
  console.log(
    `[cwd-debug] ${conv.id.slice(0, 8)} keys=[${Object.keys(data).join(',')}] data=${JSON.stringify(data).slice(0, 600)}`,
  )
}
