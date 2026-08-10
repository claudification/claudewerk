/**
 * The paste-into-a-bug-report log for a revive attempt.
 *
 * Kept pure and separate so what gets recorded is a decision, not a side effect
 * of however the dialog happens to be structured today.
 */

import type { LaunchProgressStep } from '@/hooks/use-launch-progress'
import type { Conversation } from '@/lib/types'

const STEP_ICON: Record<LaunchProgressStep['status'], string> = {
  done: '[OK]',
  error: '[FAIL]',
  // Soft pre-flight finding. The old if-chain had no branch for it and printed
  // it as pending, which hid the one status a bug report most wants to see.
  warn: '[WARN]',
  active: '[...]',
  pending: '[ ]',
}

export interface ReviveLogInput {
  conversationId: string | undefined
  conversation: Conversation | undefined
  agentHostId: string | null
  jobId: string | null
  headless: boolean
  model: string
  effort: string
  profile: string
  originalProfile: string
  steps: LaunchProgressStep[]
  error: string | null | undefined
  elapsed: number
  timestamp: string
}

/** Blank means "whatever the resolution chain picks", which is worth saying. */
function orInherited(value: string): string {
  return value || '(inherited)'
}

function formatStep(step: LaunchProgressStep): string {
  const detail = step.detail ? ` -- ${step.detail}` : ''
  return `  ${STEP_ICON[step.status]} ${step.label}${detail}`
}

function formatProfile(input: ReviveLogInput): string {
  const profile = input.profile || input.originalProfile
  if (profile === input.originalProfile) return `${profile} (pinned)`
  return `${profile} (override, original=${input.originalProfile})`
}

// CRAP-only: cc=9 is one branch per optional field in a flat log, well under
// the cyclomatic bar. Splitting it would scatter the format.
// fallow-ignore-next-line complexity
export function buildReviveLog(input: ReviveLogInput): string {
  const title = input.conversation?.title
  return [
    '=== rclaude revive log ===',
    `Time: ${input.timestamp}`,
    `Conversation: ${input.conversationId ?? 'n/a'}${title ? ` (${title})` : ''}`,
    `Project: ${input.conversation?.project ?? 'n/a'}`,
    `Wrapper: ${input.agentHostId || 'n/a'}`,
    `Job: ${input.jobId || 'n/a'}`,
    `Headless: ${input.headless}`,
    `Model: ${orInherited(input.model)}`,
    `Effort: ${orInherited(input.effort)}`,
    `Profile: ${formatProfile(input)}`,
    '',
    'Steps:',
    ...input.steps.map(formatStep),
    '',
    `Error: ${input.error || 'none'}`,
    `Elapsed: ${input.elapsed}s`,
  ].join('\n')
}
