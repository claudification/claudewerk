/**
 * NIGHTSHIFT GUARDIANS (plan-quest-engine.md §2a / §6c / §6d) -- the sweep loop
 * that drives the three deterministic guardians on top of the watchdog:
 *
 *  1. POKE PROTOCOL (§2a): a task whose card is still non-terminal while EVERY
 *     backing conversation is dead gets bounded prods, then a mechanical
 *     `errored` / `unresponsive` stamp. No card sits non-terminal behind a dead
 *     conversation.
 *  2. CRASH INVESTIGATOR (§6d): an abnormally-exited worker is triaged against
 *     the hint catalog before any retry; retry-with-remedy or terminal, bounded
 *     by a per-task attempt cap enforced in the artifact frontmatter.
 *  3. NOTIFY RULE (§6c): the transition to a terminal-error state fires the
 *     broker push as a RULE -- NO LLM in the alarm path.
 *
 * The heavy lifting lives in `-core` (primitives) + `-settle` (poke/crash
 * ladder); this file only groups conversations by task and dispatches the ones
 * with no live backing conversation.
 */

import type { Conversation } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import { buildGuardianDeps, type GuardianDeps, keyOf, pokeTracker, type TaskIds } from './nightshift-guardian-core'
import { handleOrphanTask, settleEndedWorker } from './nightshift-guardian-settle'

const SWEEP_MS = 45_000

/** One sweep: group nightshift convs by task, act only on tasks with NO live conv. */
export async function sweepGuardians(deps: GuardianDeps): Promise<void> {
  const byTask = new Map<string, { ids: TaskIds; convs: Conversation[]; anyLive: boolean }>()
  for (const conv of deps.getAllConversations()) {
    const tag = conv.launchConfig?.nightshift
    if (!tag) continue
    const ids: TaskIds = { project: conv.project, runId: tag.runId, taskId: tag.taskId }
    const key = keyOf(ids)
    const entry = byTask.get(key) ?? { ids, convs: [], anyLive: false }
    entry.convs.push(conv)
    const live = conv.status !== 'ended' || deps.getActiveConversationCount(conv.id) > 0
    if (live) entry.anyLive = true
    byTask.set(key, entry)
  }

  for (const [key, entry] of byTask) {
    if (entry.anyLive) {
      pokeTracker.delete(key) // task is being worked -- reset any poke history
      continue
    }
    // Newest ended conv represents the task's latest attempt.
    const conv = entry.convs.reduce((a, b) =>
      (b.endedBy?.at ?? b.lastActivity) > (a.endedBy?.at ?? a.lastActivity) ? b : a,
    )
    await handleOrphanTask(deps, entry.ids, conv).catch(err =>
      console.error(`[nightshift-guardian] orphan handling crashed task=${entry.ids.taskId}:`, err),
    )
  }
}

/** Start the guardian sweep loop. Mirrors the watchdog's setInterval shape. */
export function startNightshiftGuardians(
  store: ConversationStore,
  overrides: Partial<GuardianDeps> = {},
): { stop: () => void } {
  const deps = buildGuardianDeps(store, overrides)
  const timer = setInterval(() => {
    void sweepGuardians(deps).catch(err => console.error('[nightshift-guardian] sweep crashed -- swallowing:', err))
  }, SWEEP_MS)
  return { stop: () => clearInterval(timer) }
}

/** Convenience for the orchestrator: settle a just-ended worker from the store. */
export function settleWorkerFromStore(
  store: ConversationStore,
  ids: TaskIds,
  conv: Conversation,
): Promise<'terminal' | 'retried' | 'errored'> {
  return settleEndedWorker(buildGuardianDeps(store), ids, conv)
}
