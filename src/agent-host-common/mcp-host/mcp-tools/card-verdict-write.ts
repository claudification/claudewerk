/**
 * THE VERDICT WRITE -- the one side effect `card-verdict.ts` deliberately does
 * not own, and the ONLY thing standing between a review and a card that reads
 * `done` with nobody's judgement on it.
 *
 * NOT BEST-EFFORT, and that is the whole point. `writeGateEvidence` next door
 * swallows its own failure on purpose: the gate has already allowed the move and
 * a card it cannot stamp must not block work that passed. This one is the
 * opposite -- the write IS the deliverable, so a failure has to reach the caller
 * as a refusal. A verifier whose verdict silently failed to land is exactly the
 * conversation this card was written about.
 *
 * Runs on the AGENT HOST against `dialogCwd`, which is the PROJECT ROOT for
 * every seat on this board even when the seat is working inside a worktree
 * (board-gate-worktree.ts proved that measurement). So this reaches the real
 * board from a worktree, where a `Write` tool call cannot: the board is
 * gitignored, so a worktree has no copy of it to write to at all.
 */

import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../../shared/atomic-write'
import { parseCardFrontmatter } from '../../../shared/card-frontmatter'
import { renderVerdictSection, upsertVerdictSection, type VerdictInput } from '../../../shared/card-verdict'
import { serializeCard } from '../../../shared/project-card-file'

export type VerdictWriteResult = { ok: true } | { ok: false; error: string }

/**
 * Put `verdict` on the card at `cardPath`, replacing any verdict already there.
 *
 * Re-reads the file rather than taking a parse from the caller, deliberately:
 * the DONE-gate has just stamped its evidence keys into this same file, and a
 * stale parse would write them straight back out.
 *
 * Goes through `serializeCard` -- the board's ONE card writer -- so the card's
 * linkage aliases, key order and nested `promise:` block survive a verdict the
 * same way they survive a gate stamp.
 */
export function writeVerdictToCard(cardPath: string, verdict: VerdictInput): VerdictWriteResult {
  if (!cardPath) return { ok: false, error: 'the card has no resolvable path on disk' }
  let raw: string
  try {
    raw = readFileSync(cardPath, 'utf-8')
  } catch (err) {
    return { ok: false, error: `could not read ${cardPath}: ${(err as Error).message}` }
  }
  const card = parseCardFrontmatter(raw)
  const body = upsertVerdictSection(card.body, renderVerdictSection(verdict))
  try {
    writeFileAtomic(cardPath, serializeCard(card.meta, body, card.raw))
  } catch (err) {
    return { ok: false, error: `could not write ${cardPath}: ${(err as Error).message}` }
  }
  return { ok: true }
}
