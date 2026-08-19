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
import { foldByWerkUnit, latestAttempt, werkLiveness } from './werk-liveness'
import { startWerkTick } from './werk-tick'

const SWEEP_MS = 45_000

/** The task a nightshift-tagged conversation belongs to, or null when the
 *  conversation is not this trigger's work at all. */
function taskIdsOf(conv: Conversation): TaskIds | null {
  const tag = conv.launchConfig?.nightshift
  return tag ? { project: conv.project, runId: tag.runId, taskId: tag.taskId } : null
}

/**
 * One sweep: group nightshift convs by task, act only on tasks with NO live conv.
 *
 * The grouping, the liveness rule and the "newest attempt represents a settled
 * unit" pick all come from `werk-liveness.ts` -- they are WERK's rules, not
 * nightshift's, and the epic trigger folds with exactly the same three. This
 * file's own job is only the nightshift-specific part: which tag identifies a
 * unit, and what to do with one that has gone quiet.
 */
export async function sweepGuardians(deps: GuardianDeps): Promise<void> {
  const isLive = werkLiveness(deps.getActiveConversationCount)
  const units = foldByWerkUnit(deps.getAllConversations(), isLive, c => {
    const ids = taskIdsOf(c)
    return ids ? keyOf(ids) : null
  })

  for (const [key, unit] of units) {
    if (unit.anyLive) {
      pokeTracker.delete(key) // task is being worked -- reset any poke history
      continue
    }
    const conv = latestAttempt(unit)
    const ids = conv ? taskIdsOf(conv) : null
    if (!conv || !ids) continue
    await handleOrphanTask(deps, ids, conv).catch(err =>
      console.error(`[nightshift-guardian] orphan handling crashed task=${ids.taskId}:`, err),
    )
  }
}

/**
 * Start the guardian sweep loop -- on the WERK tick, the same primitive the epic
 * trigger runs on.
 *
 * It gains two things it never had. A REENTRANCY GUARD: this loop previously
 * assumed a sweep finishes inside 45s, and a slow sentinel is exactly when that
 * is false, which put two orphan handlers on one task. And the RESTART
 * QUARANTINE: on a fresh broker no host has reconnected yet, so every task looks
 * abandoned and the guardians would poke work that is running fine.
 */
export function startNightshiftGuardians(
  store: ConversationStore,
  overrides: Partial<GuardianDeps> = {},
): { stop: () => void } {
  const deps = buildGuardianDeps(store, overrides)
  return startWerkTick({
    tag: '[nightshift-guardian]',
    intervalMs: SWEEP_MS,
    run: () => sweepGuardians(deps),
    log: line => console.log(line),
    now: Date.now,
  })
}

/** Convenience for the orchestrator: settle a just-ended worker from the store. */
export function settleWorkerFromStore(
  store: ConversationStore,
  ids: TaskIds,
  conv: Conversation,
): Promise<'terminal' | 'retried' | 'errored'> {
  return settleEndedWorker(buildGuardianDeps(store), ids, conv)
}
