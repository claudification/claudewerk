/**
 * Turning the footer's form state into the payload a batch action runs with,
 * and deciding whether that form is complete enough to run at all.
 */

import type { BatchAction } from './batch-actions'

export interface ReassignFields {
  project: string
  sentinel: string
  profile: string
}

/**
 * Reassign fields are tri-state: blank leaves the value alone, `__clear__`
 * resets it to the default (an explicit null on the wire), anything else sets
 * it. A blank field must be ABSENT from the payload, not null.
 */
export function buildClearableField(
  key: 'toHostSentinelId' | 'toProfile',
  value: string,
): Record<string, string | null> {
  if (value === '__clear__') return { [key]: null }
  if (value) return { [key]: value }
  return {}
}

export function buildRunInput(action: BatchAction, broadcast: string, reassign: ReassignFields): unknown {
  if (action.requiresInput === 'broadcast') return { message: broadcast }
  if (action.requiresInput !== 'reassign') return undefined
  return {
    ...(reassign.project ? { toProjectUri: reassign.project } : {}),
    ...buildClearableField('toHostSentinelId', reassign.sentinel),
    ...buildClearableField('toProfile', reassign.profile),
  }
}

/** An action with no form is always runnable; the two that have one need it filled. */
export function isInputValid(action: BatchAction, broadcast: string, reassign: ReassignFields): boolean {
  if (action.requiresInput === 'broadcast') return broadcast.trim().length > 0
  if (action.requiresInput === 'reassign') return Boolean(reassign.project || reassign.sentinel || reassign.profile)
  return true
}
