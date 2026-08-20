/**
 * Frontmatter parsing FOR A BOARD CARD -- the flat parser, plus the one thing a
 * card knows that a nightshift run file does not: which keys are lists.
 *
 * WHY THIS FILE EXISTS. `parseFrontmatter` is a flat subset by design and
 * CAPTURES any block it cannot represent (frontmatter.ts says why at length). A
 * captured block never enters `meta`, so no reader understands it -- and a YAML
 * block list is the NATURAL way a human writes several values:
 *
 *     refs:
 *       - src/broker/archive/__tests__/ndjson.test.ts
 *     relates_to:
 *       - launch-handoff-test-load-flake
 *
 * Three live cards were written exactly like that. Their `refs:` rendered as
 * nothing on the board and that `relates_to` edge did not exist as far as the
 * board, the DAG or the epic engine were concerned -- a link that LOOKS like it
 * works, which is the precise failure card-linkage.ts was built to end.
 *
 * THE FOLD IS SCHEMA-GATED, NOT SHAPE-GATED. A block is only ever read back for
 * a key `card-schema` declares as `string[]`. `promise:` is a nested mapping
 * under a key the schema does not know, so it is untouched here and stays the
 * property of promise-ledger.ts, which parses it by line surgery precisely
 * because a YAML round trip is what inverted portal2's ledger. There is still
 * exactly one answer for that block, and it is not this one.
 *
 * BOTH ENDS, one function. Reading folds, so the board sees the edge on the
 * cards that exist today without a migration script. Writing folds too, so the
 * next write of such a card emits the inline `[a, b]` spelling and heals it for
 * good -- and so a caller that hand-assembled `meta` + `raw` cannot re-nest what
 * the reader just flattened.
 */

import { cardKeySpec } from './card-schema'
import { type Frontmatter, parseBlockSequence, parseFrontmatter, type RawBlocks } from './frontmatter'

/** A frontmatter bag and its captured blocks, the pair every card writer holds. */
interface CardMeta {
  meta: Record<string, unknown>
  raw: RawBlocks
}

/**
 * Move every block that is a plain sequence under a KNOWN list-typed key out of
 * `raw` and into `meta` as a flat string array. Everything else is left exactly
 * where it was.
 *
 * Returns the SAME objects when nothing folded, so the overwhelmingly common
 * card (no blocks at all) allocates nothing and is byte-identical through any
 * round trip that used to skip this.
 *
 * A key present in BOTH takes the block's value, which is what
 * `serializeFrontmatter` already did with the pair -- only the block can carry
 * what a nested value says, and this must not change that answer just because
 * the block now becomes readable.
 */
export function foldCardBlockLists({ meta, raw }: CardMeta): CardMeta {
  const folded: Array<[string, string[]]> = []
  for (const [key, block] of Object.entries(raw)) {
    if (cardKeySpec(key)?.type !== 'string[]') continue
    const items = parseBlockSequence(block)
    if (items) folded.push([key, items])
  }
  if (folded.length === 0) return { meta, raw }

  const nextMeta = { ...meta }
  const nextRaw = { ...raw }
  for (const [key, items] of folded) {
    nextMeta[key] = items
    delete nextRaw[key]
  }
  return { meta: nextMeta, raw: nextRaw }
}

/**
 * THE card reader. Every path that parses a card file goes through here -- the
 * store, the doctor, the DONE-gate host, the card hook, the sentinel's epic
 * meta. A card reader that calls `parseFrontmatter` directly is one that still
 * reads a block-list `relates_to:` as absent, which is the whole bug.
 *
 * Not for nightshift runs, quest manifests or epic-run state: those are not
 * cards, they render frontmatter from a typed struct, and `card-schema` has
 * nothing to say about their keys.
 */
export function parseCardFrontmatter(content: string): Frontmatter {
  const { meta, body, raw } = parseFrontmatter(content)
  const folded = foldCardBlockLists({ meta, raw })
  return { meta: folded.meta, body, raw: folded.raw }
}
