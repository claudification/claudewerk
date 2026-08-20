/**
 * The `promises` board op, run beside the files.
 *
 * Reads every card's RAW BYTES -- which is the whole reason this is a sentinel
 * op and not a browser fold. A promise lives in nested front matter, and the
 * board's own reader (`toProjectTask`) projects a card through a FLAT parser
 * that cannot represent nesting, so by the time a card reaches the wire the
 * block is already gone. Nothing downstream can recover it. Here the bytes are
 * still bytes.
 *
 * The card files are read through `project-card-read.ts`'s exported helpers so
 * "where a card lives" (canonical `cards/`, or a legacy lane directory the sweep
 * has not drained) stays ONE answer. A second walk of the board directory here
 * would be a second answer, and the one that drifted would quietly stop seeing
 * half the board.
 */

import { listCardIds, locateCard, readFileOrNull } from '../shared/project-card-read'
import type { PromiseCard, PromiseLedger } from '../shared/promise-rows'
import { promiseLedgerRows } from '../shared/promise-rows'
import { createGitResolver, resolvePromiseBase } from './promise-git'

/** Every card on the board as `{ id, text }`. A card that vanished between the
 *  listing and the read is skipped, never fatal -- this is a live board. */
function readPromiseCards(root: string): PromiseCard[] {
  const cards: PromiseCard[] = []
  for (const id of listCardIds(root)) {
    const found = locateCard(root, id)
    if (!found) continue
    const text = readFileOrNull(found.abs)
    if (text === null) continue
    cards.push({ id, text })
  }
  return cards
}

/**
 * Scan one project's board and resolve every promise on it against git.
 *
 * `project` is the canonical URI and is INFORMATIONAL -- it is stamped on the
 * result so a row is an address the wall can click, and it is never a path.
 * `root` stays the sole path input, as with every other board op.
 */
export function scanPromiseLedger(root: string, project: string, nowMs: number): PromiseLedger {
  const base = resolvePromiseBase(root)
  return promiseLedgerRows(project, readPromiseCards(root), createGitResolver(root, base), {
    resolverBase: base,
    scannedAt: nowMs,
  })
}
