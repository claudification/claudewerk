/**
 * NIGHTSHIFT GUARDIAN settle logic (plan-quest-engine.md §2a / §6d): the crash
 * investigator + retry ladder ({@link settleEndedWorker}) and the bounded poke
 * protocol ({@link handleOrphanTask}). Both stamp terminal via the shared
 * `stampTerminal` in the core, so nothing here duplicates the terminal path.
 */

import type { Conversation } from '../shared/protocol'
import { sendNightshiftOp } from './nightshift-broker-rpc'
import { buildCrashContext, makeGuardianEvent } from './nightshift-guardian-actions'
import {
  type GuardianDeps,
  inflightSettle,
  isCrashEnd,
  keyOf,
  NON_TERMINAL,
  pokeTracker,
  readTask,
  stampTerminal,
  type TaskIds,
} from './nightshift-guardian-core'

/**
 * The shared SETTLE AUTHORITY for a worker that ended with a non-terminal card.
 * Crash -> investigate (hint catalog) -> retry-with-remedy or terminal; a clean
 * end with no report -> mechanically errored. Exported so the orchestrator's
 * reap delegates here for crashes instead of duplicating the terminal-stamp
 * logic (EXTEND, don't duplicate).
 */
export async function settleEndedWorker(
  deps: GuardianDeps,
  ids: TaskIds,
  conv: Conversation,
): Promise<'terminal' | 'retried' | 'errored'> {
  const key = keyOf(ids)
  if (inflightSettle.has(key)) return 'terminal'
  inflightSettle.add(key)
  try {
    const task = await readTask(deps, ids)
    if (!task || !NON_TERMINAL.has(task.status)) return 'terminal'

    if (!isCrashEnd(conv)) {
      await stampTerminal(deps, ids, conv, 'unresponsive', 'worker ended without reporting an outcome')
      return 'errored'
    }

    // Crash path -- hard attempt cap first (max 3 via frontmatter `attempts`).
    if (task.attempts >= deps.attemptCap) {
      deps.emit(
        makeGuardianEvent(deps.now(), {
          kind: 'cap-hit',
          ...ids,
          conversationId: conv.id,
          profile: conv.resolvedProfile,
          attempt: task.attempts,
          cap: deps.attemptCap,
          reason: `crash attempt cap ${deps.attemptCap} reached`,
        }),
      )
      await stampTerminal(deps, ids, conv, 'cap-hit', `crash attempt cap ${deps.attemptCap} reached`)
      return 'errored'
    }

    const crashCtx = buildCrashContext(conv, { ...ids, attempts: task.attempts, attemptCap: deps.attemptCap })
    const verdict = await deps.investigate(crashCtx)
    deps.emit(
      makeGuardianEvent(deps.now(), {
        kind: 'investigate',
        ...ids,
        conversationId: conv.id,
        profile: conv.resolvedProfile,
        attempt: task.attempts,
        cap: deps.attemptCap,
        verdict: verdict.verdict,
        hintKey: verdict.hintKey,
        reason: verdict.reason,
      }),
    )

    if (verdict.verdict !== 'retryable') {
      await stampTerminal(deps, ids, conv, 'crash-fatal', verdict.reason)
      return 'errored'
    }

    const nextAttempt = task.attempts + 1
    // Bump the frontmatter counter BEFORE respawning so a crash of the retry (or
    // a broker restart mid-retry) can never lose the attempt (§14).
    await sendNightshiftOp(deps, ids.project, {
      op: 'task_patch',
      runId: ids.runId,
      taskPatch: {
        id: ids.taskId,
        status: 'running',
        attempts: nextAttempt,
        note: `retry ${nextAttempt}/${deps.attemptCap} after crash -- ${verdict.reason}`,
      },
    })
    deps.emit(
      makeGuardianEvent(deps.now(), {
        kind: 'retry',
        ...ids,
        conversationId: conv.id,
        profile: conv.resolvedProfile,
        attempt: nextAttempt,
        cap: deps.attemptCap,
        verdict: 'retryable',
        hintKey: verdict.hintKey,
        reason: verdict.remedy ?? verdict.reason,
      }),
    )
    const ok = await deps.dispatchRetry(crashCtx, nextAttempt, verdict.remedy)
    if (!ok) {
      await stampTerminal(deps, ids, conv, 'crash-fatal', 'retry respawn failed')
      return 'errored'
    }
    return 'retried'
  } finally {
    inflightSettle.delete(key)
  }
}

/**
 * POKE protocol for a dead, non-crash, non-terminal task: bounded prods (max
 * `deps.maxPokes`, with backoff) delivered through the existing revive/message
 * path, then a mechanical terminal stamp. Crashes route to
 * {@link settleEndedWorker} instead.
 */
async function pokeOrStamp(deps: GuardianDeps, ids: TaskIds, conv: Conversation): Promise<void> {
  const key = keyOf(ids)
  const tracker = pokeTracker.get(key) ?? { count: 0, lastAt: 0 }

  if (tracker.count < deps.maxPokes) {
    if (tracker.count > 0 && deps.now() - tracker.lastAt < deps.pokeBackoffMs) return // backing off
    const delivered = deps.deliverPoke(conv)
    tracker.count += 1
    tracker.lastAt = deps.now()
    pokeTracker.set(key, tracker)
    deps.emit(
      makeGuardianEvent(deps.now(), {
        kind: 'poke',
        ...ids,
        conversationId: conv.id,
        profile: conv.resolvedProfile,
        attempt: tracker.count,
        cap: deps.maxPokes,
        reason: delivered ? 'prod delivered to non-terminal dead worker' : 'poke undeliverable (no socket/sentinel)',
      }),
    )
    return
  }

  // Pokes exhausted -- mechanical terminal stamp.
  deps.emit(
    makeGuardianEvent(deps.now(), {
      kind: 'poke-exhausted',
      ...ids,
      conversationId: conv.id,
      profile: conv.resolvedProfile,
      attempt: tracker.count,
      cap: deps.maxPokes,
      reason: `no terminal status after ${deps.maxPokes} pokes`,
    }),
  )
  await stampTerminal(deps, ids, conv, 'unresponsive', `no terminal status after ${deps.maxPokes} pokes`)
}

/** Handle one orphaned task (no live conversation, non-terminal card): crashes
 *  are investigated/retried; everything else runs the bounded poke protocol. */
export async function handleOrphanTask(deps: GuardianDeps, ids: TaskIds, conv: Conversation): Promise<void> {
  const key = keyOf(ids)
  if (inflightSettle.has(key)) return
  const task = await readTask(deps, ids)
  if (!task || !NON_TERMINAL.has(task.status)) {
    pokeTracker.delete(key)
    return
  }
  if (isCrashEnd(conv)) {
    await settleEndedWorker(deps, ids, conv)
    return
  }
  await pokeOrStamp(deps, ids, conv)
}
