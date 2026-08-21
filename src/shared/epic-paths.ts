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

/**
 * WHERE A DELETED RUN GOES -- the tombstone yard.
 *
 * A dot-prefixed sibling of the runs themselves, which is what makes it safe:
 * `SAFE_ID` forbids a leading dot, so no epic id can ever address this directory
 * and no run can ever be written inside it. Nothing enumerates `epics/` either,
 * so a tombstone cannot leak back onto a surface as a phantom run.
 *
 * `delete` is a MOVE and never an `rm` (see `deleteEpicRun`). A true purge of
 * this directory is a separate, rarer, explicitly-destructive operation that
 * deliberately does not exist yet -- and if it is ever built it is CLI-only.
 */
const DELETED_DIR = '.deleted'

export function deletedEpicsRoot(root: string): string {
  return join(epicsRoot(root), DELETED_DIR)
}

/**
 * `.rclaude/project/epics/.deleted/<id>-<stamp>`.
 *
 * The stamp is the ISO instant with its punctuation flattened to hyphens. Two
 * reasons, and neither is cosmetic: a colon is a legal path character here and
 * an illegal one on the filesystems this project's artifacts get copied to, and
 * a per-instant name means deleting the same epic twice never clobbers the first
 * tombstone -- which would be an `rm` wearing a `mv`'s clothes.
 */
export function deletedEpicDir(root: string, epicId: string, nowMs: number): string {
  return join(deletedEpicsRoot(root), `${safeEpicId(epicId)}-${nowIso(nowMs).replace(/[:.]/g, '-')}`)
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
