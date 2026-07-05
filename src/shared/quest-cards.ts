/**
 * Quest <-> board-card bridge (plan-quest-engine §4a/§4c/§13). Quest membership
 * lives as a `quest: <petname>` frontmatter key on ordinary project-board cards;
 * this module is the ONLY place that reasons about that membership, reusing the
 * board store (never re-implementing card I/O -- DRY covenant).
 *
 * §4c: membership is ORTHOGONAL to a card's lane. The completion predicate is
 * COMPUTED here (§11 -- never asserted by an orchestrator).
 */

import { getProjectTask, listProjectTasks, moveProjectTask, updateProjectTask } from './project-store'
import type { ProjectTaskMeta, ProjectTaskRef } from './project-task-types'
import { isTerminalCardStatus, type QuestCardState, type QuestManifest, type QuestStatusReport } from './quest-schema'
import type { TaskStatus } from './task-statuses'

/** Every board card belonging to a quest (by `quest: <petname>` frontmatter). */
export function listQuestCards(root: string, petname: string): ProjectTaskMeta[] {
  return listProjectTasks(root).filter(t => t.quest === petname)
}

/** Tag a set of cards into a quest. Skips refs that don't resolve. Returns the
 *  slugs actually tagged. */
export function tagQuestCards(root: string, petname: string, refs: ProjectTaskRef[]): string[] {
  const tagged: string[] = []
  for (const ref of refs) {
    const updated = updateProjectTask(root, ref.status, ref.slug, { quest: petname })
    if (updated) tagged.push(updated.slug)
  }
  return tagged
}

/**
 * Compute the §4c predicate: per-card terminal states + a completion boolean.
 * v1 (this packet): `complete` = every quest card terminal AND the quest is not
 * aborted; delivered-per-target integrator semantics arrive with a later packet.
 */
export function computeQuestStatus(root: string, manifest: QuestManifest): QuestStatusReport {
  const cards: QuestCardState[] = listQuestCards(root, manifest.petname).map(c => ({
    slug: c.slug,
    status: c.status,
    terminal: isTerminalCardStatus(c.status),
  }))
  const terminalCount = cards.filter(c => c.terminal).length
  const allTerminal = cards.length > 0 && terminalCount === cards.length
  return {
    petname: manifest.petname,
    target: manifest.target,
    status: manifest.status,
    cards,
    total: cards.length,
    terminalCount,
    allTerminal,
    complete: allTerminal && manifest.status !== 'aborted',
  }
}

export interface AbortedCard {
  slug: string
  from: TaskStatus
  to: TaskStatus
}

/**
 * §13 abort: stamp every NON-terminal quest card `archived` with a
 * SKIPPED-by-abort reason. Terminal cards (done/archived) are left as-is.
 * Returns what was stamped. Draining running legs is OUT (orchestrator packet).
 */
export function stampAbortCards(root: string, petname: string, reason: string, nowMs: number): AbortedCard[] {
  const out: AbortedCard[] = []
  for (const card of listQuestCards(root, petname)) {
    if (isTerminalCardStatus(card.status)) continue
    const from = card.status
    const existing = getProjectTask(root, from, card.slug)
    const newSlug = moveProjectTask(root, card.slug, from, 'archived', nowMs)
    if (!newSlug) continue
    const body = `${(existing?.body ?? '').trimEnd()}\n\n> SKIPPED-by-abort (${petname}): ${reason.replace(/\n+/g, ' ').trim()}`
    updateProjectTask(root, 'archived', newSlug, { body })
    out.push({ slug: newSlug, from, to: 'archived' })
  }
  return out
}
