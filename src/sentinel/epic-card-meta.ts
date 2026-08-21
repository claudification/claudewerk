/**
 * THE EPIC CARD'S FRONTMATTER, read and patched -- the half of epic state that
 * does NOT live in the run artifact.
 *
 * The lease lives on the CARD rather than in `run.md` so a human reading the
 * board can see, and break, a stuck overseer without knowing the engine's
 * storage layout. That makes the card a second write target, and these two
 * functions are all of it.
 *
 * Split out of `epic-handlers.ts` when that file crossed 200 lines: the op map
 * is the interesting part of that file, and two file-I/O helpers sitting above
 * it were the first thing a reader had to scroll past.
 *
 * `casLeaseOnCard` joined them because BOTH lease scopes -- the epic's overseer
 * singleton and a work card's per-role seat -- perform the identical
 * read-evaluate-write, and the invariant that makes it a CAS is a property of
 * THESE LINES rather than of either caller.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { parseCardFrontmatter } from '../shared/card-frontmatter'
import { type EpicLease, evaluateLease, type LeaseRequest, leasePatch, readLease } from '../shared/epic-lease'
import { serializeFrontmatter } from '../shared/frontmatter'
import { cardPath } from '../shared/project-paths'
import type { EpicResult } from '../shared/protocol'

/** Read-modify-write of the card's frontmatter. False when there is no card --
 *  never a throw, because every caller is inside an op that must answer. */
export function patchCardMeta(root: string, epicId: string, patch: Record<string, unknown>): boolean {
  const file = cardPath(root, epicId, false)
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return false
  }
  const { meta, body, raw: blocks } = parseCardFrontmatter(raw)
  // `blocks` is not optional here even though the argument is. This writes a
  // BOARD CARD, and an epic card is exactly the kind that carries a `promise:`
  // block -- dropping it would empty `closes:` every time the overseer took or
  // released the lease.
  writeFileSync(file, serializeFrontmatter({ ...meta, ...patch }, body, blocks), 'utf8')
  return true
}

export function readCardMeta(root: string, epicId: string): Record<string, unknown> | null {
  try {
    return parseCardFrontmatter(readFileSync(cardPath(root, epicId, false), 'utf8')).meta
  } catch {
    return null
  }
}

/**
 * ONE COMPARE-AND-SWAP, both scopes: the overseer singleton on the epic card and
 * a seat on a work card differ only in `keyPrefix` and which card they land on.
 *
 * NO AWAIT BETWEEN THE READ AND THE WRITE. That is the entire CAS, and it is a
 * property of these six lines rather than of any caller -- which is exactly why
 * they live here once instead of once per scope. Two racing wakes would
 * otherwise both read the same generation and both grant. Node's
 * single-threaded synchronous fs is what makes it safe; if this ever moves off
 * it, this is the code that breaks.
 *
 * `meta` is passed IN rather than read here because every caller has already
 * read it to prove the card exists, and re-reading would put the file in two
 * hands one microtask apart for no gain.
 */
export function casLeaseOnCard(
  root: string,
  cardId: string,
  keyPrefix: string,
  meta: Record<string, unknown>,
  req: LeaseRequest,
  nowMs: number,
): NonNullable<EpicResult['lease']> {
  const decision = evaluateLease(readLease(meta, keyPrefix), req, nowMs)
  if (!decision.grant) {
    const h: EpicLease = decision.holder
    return { granted: false, convId: h.convId, gen: h.gen, at: h.at, reason: decision.reason }
  }
  patchCardMeta(root, cardId, leasePatch(decision.lease, keyPrefix))
  return { granted: true, ...decision.lease, ...(decision.replaced ? { replaced: decision.replaced } : {}) }
}
