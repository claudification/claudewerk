/**
 * Shaping an epic's state into the inspect projection. PURE -- every function
 * here takes what the broker already fetched and returns a wire type, so the
 * interesting part of `epic_run action=inspect` is testable with no sentinel, no
 * conversation store and no clock.
 *
 * The IO half lives in `epic-inspect.ts`. Splitting them is not ceremony: the
 * questions this file answers ("which lane is this card in", "does the registry
 * disagree with run.md") are exactly the ones a regression would land on, and
 * they are worth being able to assert on directly.
 */

import type { EpicPlan } from '../shared/epic-ready'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type {
  Conversation,
  EpicInspectCard,
  EpicInspectConversation,
  EpicInspectLive,
  EpicInspectPlan,
} from '../shared/protocol'
import { type EpicGroup, generationMismatch, type IsLive } from './epic-sweep'

/** Card -> the four fields an inspect actually renders. */
function card(meta: ProjectTaskMeta, waitingOn?: string[]): EpicInspectCard {
  return {
    id: meta.slug,
    title: meta.title,
    status: meta.status,
    ...(waitingOn?.length ? { waitingOn } : {}),
  }
}

/** The arithmetic half. A null plan rollup means the epic is not on the board,
 *  which is a different fact from "on the board with nothing to do" -- the
 *  caller reports it as an error rather than an empty plan. */
export function toInspectPlan(plan: EpicPlan): EpicInspectPlan {
  return {
    children: plan.rollup?.children.length ?? 0,
    dispatch: plan.dispatch.map(c => card(c)),
    verify: plan.verify.map(c => card(c)),
    questions: plan.questions.map(c => card(c)),
    heldBack: plan.heldBack.map(c => card(c)),
    waitingOnDeps: plan.waitingOnDeps.map(w => card(w.card, w.waitingOn)),
    complete: plan.complete,
    ...(plan.idleReason ? { idleReason: plan.idleReason } : {}),
  }
}

/**
 * Every conversation carrying this epic's launch tag, newest generation first.
 *
 * This is the view that did not exist: debugging a stuck run meant listing all
 * conversations and eyeballing `launchConfig.epic` by hand, which is both
 * tedious and the sort of thing you get wrong at 2am when a card has a dead
 * retry-predecessor sitting next to its live retry.
 */
export function epicConversations(
  convs: readonly Conversation[],
  isLive: IsLive,
  epicId: string,
): EpicInspectConversation[] {
  const rows: EpicInspectConversation[] = []
  for (const conv of convs) {
    const tag = conv.launchConfig?.epic
    if (tag?.epicId !== epicId) continue
    rows.push({
      id: conv.id,
      role: tag.role,
      ...(tag.cardId ? { cardId: tag.cardId } : {}),
      gen: tag.gen,
      status: conv.status,
      live: isLive(conv),
    })
  }
  return rows.sort((a, b) => b.gen - a.gen || a.id.localeCompare(b.id))
}

export interface LiveInput {
  group: EpicGroup
  armed: boolean
  /** Settled cards the baton has never acknowledged (`unacknowledgedCards`). */
  unacknowledged: readonly string[]
  /**
   * THE LEASE'S generation -- `overseer_gen` on the epic card, which is the only
   * copy of it there is. 0 when the read succeeded and the epic has never been
   * woken; `null` when the READ ITSELF failed and the generation is therefore
   * unknown.
   *
   * The three cases are not two: comparing the registry against a gen-0 default
   * that came from a timed-out RPC is what printed `conversations tagged gen 6
   * but run.md says 0` about a healthy gen-6 run.
   */
  leaseGen: number | null
  conversations: EpicInspectConversation[]
}

/** The registry half. `generationMismatch` was previously a log line nobody read
 *  -- it is the tell for spawns racing the lease, which freezes a run silently,
 *  so it is promoted to a field an inspect always shows when present. An UNREAD
 *  run has no generation to disagree with, so the comparison is not made at all
 *  rather than made against a default. */
export function toInspectLive(input: LiveInput): EpicInspectLive {
  const mismatch = input.leaseGen === null ? null : generationMismatch(input.group, input.leaseGen)
  return {
    armed: input.armed,
    inFlight: [...input.group.inFlight],
    settled: [...input.group.settled],
    unacknowledged: [...input.unacknowledged],
    werkMasterAlive: input.group.werkMasterAlive,
    maxGenSeen: input.group.maxGenSeen,
    ...(mismatch ? { generationMismatch: mismatch } : {}),
    conversations: input.conversations,
  }
}
