/**
 * Epic run tree layout -- where an epic's run state and baton live:
 *
 *   <project>/.rclaude/project/epics/<epicId>/
 *     run.md    run frontmatter (EpicRunMeta) + a prose digest body
 *     log.md    the append-only baton
 *
 * Deliberately a SIBLING of `quests/`, not a reuse of it: a quest is selected by
 * petname and carries its own acceptance contracts, an epic is selected by the
 * board card that already exists. Same shape, different selector.
 *
 * Pure path math. The epic id is a card slug, so it gets the same traversal
 * check the board applies -- an id is a file name, never a path.
 */

import { join } from 'node:path'

/** Card slugs are lowercase-hyphen handles. Anything else is not an id. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/

function epicsRoot(root: string): string {
  return join(root, '.rclaude', 'project', 'epics')
}

export function epicDir(root: string, epicId: string): string {
  return join(epicsRoot(root), safeEpicId(epicId))
}

export function epicRunFile(root: string, epicId: string): string {
  return join(epicDir(root, epicId), 'run.md')
}

export function epicLogFile(root: string, epicId: string): string {
  return join(epicDir(root, epicId), 'log.md')
}

export function isValidEpicId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes('..')
}

export function safeEpicId(epicId: string): string {
  if (!isValidEpicId(epicId)) throw new Error(`invalid epic id: ${epicId}`)
  return epicId
}

/**
 * The SAME rule, said about a card.
 *
 * The seat lease writes a card that is not the epic's own (epic-seat-lease.ts),
 * so it reaches `cardPath` with an id the epic path helpers never see -- and
 * `cardPath` does no checking of its own. Its own function rather than a reuse
 * of `safeEpicId` because the message a traversal attempt produces has to name
 * the thing that was actually wrong.
 */
export function safeCardId(cardId: string): string {
  if (!isValidEpicId(cardId)) throw new Error(`invalid card id: ${cardId}`)
  return cardId
}

export function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString()
}
