/**
 * One card on disk: parse, project to the wire shape, serialize back.
 *
 * PRESERVE-UNKNOWN-KEYS is the load-bearing rule here. A card's frontmatter is
 * not a closed schema -- the DONE-gate machine-authors `evidence_branch`,
 * `evidence_base`, `evidence_commits`, `evidence_diffstat`, `evidence_tests`,
 * `evidence_worker`; cards carry `gate:`, `test_cmd:`, `base:`. The old store
 * rebuilt every card from a fixed key list, so any update silently destroyed
 * all of it (a Guard bounce wiped the evidence it had just been checked
 * against). Every write here round-trips the full bag and overlays only what
 * the caller actually patched.
 */

import { statSync } from 'node:fs'
import { makeBodyPreview } from './body-preview'
import { foldCardBlockLists, parseCardFrontmatter } from './card-frontmatter'
import { asCardValueList, normalizeLinkageMeta, readLinkage, readOne } from './card-linkage-read'
import { CARD_PRIORITIES, ORDERED_CARD_KEYS } from './card-schema'
import { type RawBlocks, serializeFrontmatter } from './frontmatter'
import type { ProjectTask } from './project-task-types'
import { TASK_STATUSES, type TaskStatus } from './task-statuses'
import { isWallPinned } from './wall-pin'

/** Keys the store owns and renders in a stable order. Everything else is
 *  preserved verbatim, after these. DERIVED, not declared: the order lives in
 *  card-schema-keys.ts with the rest of what a key is, so the two can no longer
 *  drift (card-schema.test.ts pins it against the literal list it replaced). */
const ORDERED_KEYS = ORDERED_CARD_KEYS

type Priority = (typeof CARD_PRIORITIES)[number]

/** An empty list is the same fact as an absent key, and projecting `[]` would
 *  make every card on the board claim a rename history it does not have. */
function undefinedIfEmpty(list: string[]): string[] | undefined {
  return list.length > 0 ? list : undefined
}

function asPriority(v: unknown): Priority | undefined {
  return (CARD_PRIORITIES as readonly string[]).includes(String(v)) ? (String(v) as Priority) : undefined
}

export function asStatus(v: unknown): TaskStatus | undefined {
  return (TASK_STATUSES as readonly string[]).includes(String(v)) ? (String(v) as TaskStatus) : undefined
}

export interface RawCard {
  meta: Record<string, unknown>
  body: string
  /** Nested blocks the flat parser cannot represent, carried so the write side
   *  can put them back untouched. PRESERVE-UNKNOWN-KEYS applies to SHAPES too:
   *  dropping this on the way out is the same bug wearing a different hat. */
  raw: RawBlocks
  mtime: number
}

/** Parse a card file. Returns null if it can't be read. */
export function readRawCard(abs: string, content: string | null): RawCard | null {
  if (content === null) return null
  const { meta, body, raw } = parseCardFrontmatter(content)
  let mtime = 0
  try {
    mtime = statSync(abs).mtimeMs
  } catch {
    /* caller already has the content; a missing stat just means mtime 0 */
  }
  return { meta, body, raw, mtime }
}

/**
 * Project a parsed card to the wire shape. `fallbackStatus` covers a legacy
 * card whose lane directory is the only place its status is recorded; a
 * `status:` key always wins.
 */
export function toProjectTask(raw: RawCard, id: string, fallbackStatus?: TaskStatus): ProjectTask {
  const body = raw.body
  // Linkage goes through the registry, never straight off `meta`: that is what
  // makes `blocked_by:` actually work rather than merely survive, and what stops
  // a scalar `depends_on: one-card` from silently reading as nothing at all.
  // Keys keep their snake_case names on disk (that is what the cards already
  // carry); the wire shape is camelCase like every other field.
  const linkage = readLinkage(raw.meta)
  return {
    slug: id,
    status: asStatus(raw.meta.status) ?? fallbackStatus ?? 'inbox',
    title: String(raw.meta.title || id),
    priority: asPriority(raw.meta.priority),
    tags: Array.isArray(raw.meta.tags) ? raw.meta.tags.map(String) : [],
    refs: linkage.refs ?? [],
    quest: readOne(linkage, 'quest'),
    epic: readOne(linkage, 'epic'),
    color: raw.meta.color === undefined ? undefined : String(raw.meta.color),
    // Only ever `true` on the wire. An unpinned card carries no key at all, so
    // projecting `false` would make every card on the board claim a pin state it
    // does not have.
    wallPinned: isWallPinned(raw.meta) || undefined,
    dependsOn: linkage.depends_on,
    relatesTo: linkage.relates_to,
    // NOT off `linkage` -- `renamed_from` deliberately is not a linkage verb (see
    // card-schema-keys.ts), so it is read here with the same coercion the verbs
    // get. Scalar or list, both work: the one card carrying it today writes a
    // bare id, and a card renamed twice needs to keep both.
    renamedFrom: undefinedIfEmpty(asCardValueList(raw.meta.renamed_from)),
    created: String(raw.meta.created || ''),
    mtime: raw.mtime,
    body,
    bodyPreview: makeBodyPreview(body),
  }
}

/**
 * Serialize a card, store-owned keys first (stable order) then every other key
 * the file already carried, untouched.
 *
 * Linkage aliases collapse onto their stored key on the way out -- ONE spelling
 * of each fact reaches disk, so no reader ever has to check two. This is the
 * single exception to preserve-unknown-keys, and only because the two spellings
 * are the same fact: nothing is lost, it is just spelled once.
 *
 * `raw` is the card's nested blocks, straight off `readRawCard`/`parseCardFrontmatter`.
 * REQUIRED, unlike `serializeFrontmatter`'s optional third argument, and that is
 * the point: a card writer that forgets it drops a `promise:` block and empties
 * its `closes:`, so a delivered promise reads as never started. A doc comment
 * does not stop that; a compile error does. A caller building a card from
 * scratch passes `{}` and says so out loud.
 *
 * A block list under a list-typed key is FOLDED into the flat value on the way
 * out (card-frontmatter.ts), so writing a card written that way by hand heals it
 * to the inline `[a, b]` spelling every reader here understands. Done here and
 * not only in the reader because a caller may hand-assemble `meta` + `raw`, and
 * because this is the one door every card write goes through.
 */
export function serializeCard(meta: Record<string, unknown>, body: string, raw: RawBlocks): string {
  const folded = foldCardBlockLists({ meta, raw })
  const normalized = normalizeLinkageMeta(folded.meta)
  const ordered: Record<string, unknown> = {}
  for (const key of ORDERED_KEYS) {
    const val = normalized[key]
    if (val !== undefined && val !== null && val !== '') ordered[key] = val
  }
  for (const [key, val] of Object.entries(normalized)) {
    if (!(ORDERED_KEYS as readonly string[]).includes(key)) ordered[key] = val
  }
  return serializeFrontmatter(ordered, body, folded.raw)
}
