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
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { parseFrontmatter, serializeFrontmatter } from '../shared/frontmatter'
import { cardPath } from '../shared/project-paths'

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
  const { meta, body, raw: blocks } = parseFrontmatter(raw)
  // `blocks` is not optional here even though the argument is. This writes a
  // BOARD CARD, and an epic card is exactly the kind that carries a `promise:`
  // block -- dropping it would empty `closes:` every time the overseer took or
  // released the lease.
  writeFileSync(file, serializeFrontmatter({ ...meta, ...patch }, body, blocks), 'utf8')
  return true
}

export function readCardMeta(root: string, epicId: string): Record<string, unknown> | null {
  try {
    return parseFrontmatter(readFileSync(cardPath(root, epicId, false), 'utf8')).meta
  } catch {
    return null
  }
}
