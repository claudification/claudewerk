/**
 * Build the SpawnRequest that launches a fork.
 *
 * Pulled out of `useForkAction` because the request SHAPE is the whole ballgame:
 * get a field wrong here and the fork boots as a perfectly healthy conversation
 * that inherited nothing, which looks like success. Pure function, so the rules
 * below are testable without a store or a socket.
 */

import { DEFAULT_PROFILE_NAME, type SpawnRequest } from '@shared/spawn-schema'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'

export interface ForkLaunchOverrides {
  name?: string
  model?: string
  effort?: string
  /** Target working directory; defaults to the source conversation's project. */
  cwd?: string
  worktree?: string
  prompt?: string
  /** Transport for the fork. Undefined leaves the backend default in place. */
  headless?: boolean
}

export interface ForkLaunchSource {
  /** Folded transcript to resume. Mutually exclusive with `seedPrompt`. */
  resumeId?: string | null
  /** Summary-mode seed: a FRESH session carrying inherited context. */
  seedPrompt?: string | null
}

/**
 * A fork can only resume on the profile that holds its transcript.
 *
 * The fold is written under the source conversation's profile config dir, and
 * CC looks for `--resume` under the profile it boots on. Leaving this off is
 * not neutral -- the sentinel's picker consults `defaultSelection` and can land
 * on another profile, where the resume finds nothing and starts empty.
 *
 * A summary fork is exempt: it resumes nothing, so no profile holds it.
 */
function forkLaunchProfile(conversation: Conversation, resumeId?: string | null): string | undefined {
  if (!resumeId) return undefined
  return conversation.resolvedProfile || DEFAULT_PROFILE_NAME
}

export function buildForkSpawnRequest(
  conversation: Conversation,
  source: ForkLaunchSource,
  overrides: ForkLaunchOverrides,
): SpawnRequest {
  const { resumeId, seedPrompt } = source

  return {
    cwd: overrides.cwd?.trim() || projectPath(conversation.project),
    ...(resumeId
      ? { mode: 'resume' as const, resumeId }
      : // Summary mode: a FRESH session whose system prompt carries the
        // inherited context. appendSystemPrompt rather than `prompt`, so the
        // context is ambient and the agent is not handed a turn to execute.
        { appendSystemPrompt: seedPrompt ?? undefined }),
    name: overrides.name?.trim() || undefined,
    model: (overrides.model || undefined) as SpawnRequest['model'],
    effort: (overrides.effort || undefined) as SpawnRequest['effort'],
    worktree: overrides.worktree?.trim() || undefined,
    prompt: overrides.prompt?.trim() || undefined,
    headless: overrides.headless,
    profile: forkLaunchProfile(conversation, resumeId),
    jobId: crypto.randomUUID(),
  }
}
