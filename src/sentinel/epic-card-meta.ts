/**
 * THE EPIC CARD'S FRONTMATTER, read and patched -- the half of epic state that
 * does NOT live in the run artifact.
 *
 * The lease lives on the CARD rather than in `run.md` so a human reading the
 * board can see, and break, a stuck werk-master without knowing the engine's
 * storage layout. That makes the card a second write target, and these two
 * functions are all of it.
 *
 * Split out of `epic-handlers.ts` when that file crossed 200 lines: the op map
 * is the interesting part of that file, and two file-I/O helpers sitting above
 * it were the first thing a reader had to scroll past.
 *
 * `casLeaseOnCard` joined them because BOTH lease scopes -- the epic's werk-master
 * singleton and a work card's per-role seat -- perform the identical
 * read-evaluate-write, and the invariant that makes it a CAS is a property of
 * THESE LINES rather than of either caller.
 */

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../shared/atomic-write'
import { parseCardFrontmatter } from '../shared/card-frontmatter'
import { type EpicLease, evaluateLease, type LeaseRequest, leasePatch, readLease } from '../shared/epic-lease'
import { type RawBlocks, serializeFrontmatter } from '../shared/frontmatter'
import { cardPath } from '../shared/project-paths'
import type { EpicResult } from '../shared/protocol'

/**
 * THE CARD IS THERE AND CANNOT BE BELIEVED -- the third outcome of opening a card
 * that holds a lease, and the exact counterpart of `EpicRunUnreadableError`
 * (epic-run-store.ts). Two halves, same pair: `writeFileAtomic` below stops the
 * tear, this stops a tear from being BELIEVED.
 *
 * WHAT BELIEVING ONE COSTS, and it is worse here than on `run.md`.
 * `parseCardFrontmatter` answers a file with no complete block with `{ meta: {} }`,
 * and an empty bag reads through `readLease` as `null` -- which `evaluateLease`
 * defines, correctly, as "this epic has NEVER been woken" and grants at
 * generation 1. So a torn card silently RESETS the generation counter that is the
 * CAS's entire basis: the baton already holds gens 1..N, the next wake writes a
 * second gen 1, and two different beats share one id. That is the drift that cost
 * `epic-the-wall-ii` hours on 2026-08-20, arrived at through the front door.
 *
 * And the WRITE is worse than the read. `patchCardMeta` is read-modify-write over
 * the whole card, so a patch applied to `{}` does not merely lose the lease: it
 * emits a card whose entire frontmatter is the three lease keys -- no `title`, no
 * `status`, no `epic:`, no `depends_on:`, no promise ledger. One torn read turns a
 * recoverable tear into a destroyed card.
 *
 * RECOVERY IS BY HAND, and the board is in git, so it is one `git checkout` of the
 * card. Nothing here may decide on its own that a card's frontmatter is disposable.
 */
export class EpicCardUnreadableError extends Error {
  constructor(cardId: string, why: string) {
    super(
      `card \`${cardId}\` is present but UNREADABLE (${why}) -- it is truncated or corrupt. ` +
        `Refusing to read it as a card with no lease; restore it (\`git checkout\` the card) and retry.`,
    )
    this.name = 'EpicCardUnreadableError'
  }
}

/** ENOENT, as a value the two exported functions turn into their own zero --
 *  `false` for a patch, `null` for a read. Never leaves this module. */
class CardAbsent extends Error {}

/**
 * ALL THREE OUTCOMES OF OPENING A CARD, decided in one place: `CardAbsent` when
 * there is no such card, the parse when it is intact, `EpicCardUnreadableError`
 * when it is neither.
 *
 * BOTH FAILURES ARE THROWS rather than return values, which is
 * `EpicRunUnreadableError`'s design verbatim and for its reason: every op in this
 * sentinel goes through `runGuarded` (`epic-handlers.ts`), which turns a throw
 * into `{ ok: false, error }`. So one throw makes EVERY op refuse -- `get`,
 * `lease`, `release`, `pause`, `abort` and all three `seat_*` -- instead of eight
 * call sites each remembering to check a flag.
 */
function readCardFile(
  root: string,
  cardId: string,
): { meta: Record<string, unknown>; body: string; blocks: RawBlocks } {
  let text: string
  try {
    text = readFileSync(cardPath(root, cardId, false), 'utf8')
  } catch (err) {
    // ENOENT is the ONLY "no card" answer. Swallowing the errno here is what let a
    // permissions problem read as a card that simply does not exist.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new CardAbsent()
    throw new EpicCardUnreadableError(cardId, err instanceof Error ? err.message : String(err))
  }
  const parsed = parseCardFrontmatter(text)
  // A torn write can only ever leave a PREFIX of the intended bytes, and the
  // closing `---` is written after the last key -- so "no complete block" covers
  // the whole realistic truncation space, empty file included.
  if (!parsed.hasFrontmatter) throw new EpicCardUnreadableError(cardId, 'the card carries no frontmatter block')
  return { meta: parsed.meta, body: parsed.body, blocks: parsed.raw }
}

/**
 * Read-modify-write of the card's frontmatter. False when there is no card;
 * THROWS `EpicCardUnreadableError` when there is one and it is torn.
 *
 * THE WRITE IS ATOMIC, which it was not until this card. `project-card-write.ts`
 * -- every other writer of a board card -- goes through `writeFileAtomic` and says
 * why at length: a bare `writeFileSync` truncates and then writes, so a sentinel
 * killed inside that window leaves a card that still exists and no longer carries
 * its own `epic:`, `depends_on:` or promise ledger. This function was the one card
 * writer that had been missed, and it is the one that writes the LEASE -- the
 * mutual-exclusion state the engine's whole one-writer-per-card guarantee rests on.
 */
export function patchCardMeta(root: string, epicId: string, patch: Record<string, unknown>): boolean {
  let card: { meta: Record<string, unknown>; body: string; blocks: RawBlocks }
  try {
    card = readCardFile(root, epicId)
  } catch (err) {
    if (err instanceof CardAbsent) return false
    throw err
  }
  // `blocks` is not optional here even though the argument is. This writes a
  // BOARD CARD, and an epic card is exactly the kind that carries a `promise:`
  // block -- dropping it would empty `closes:` every time the werk-master took or
  // released the lease.
  writeFileAtomic(
    cardPath(root, epicId, false),
    serializeFrontmatter({ ...card.meta, ...patch }, card.body, card.blocks),
  )
  return true
}

/** The card's frontmatter, or null when there is no such card. THROWS
 *  `EpicCardUnreadableError` on a card that is present and torn -- see that class
 *  for why an empty bag is the single most expensive wrong answer here. */
export function readCardMeta(root: string, epicId: string): Record<string, unknown> | null {
  try {
    return readCardFile(root, epicId).meta
  } catch (err) {
    if (err instanceof CardAbsent) return null
    throw err
  }
}

/**
 * ONE COMPARE-AND-SWAP, both scopes: the werk-master singleton on the epic card and
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
