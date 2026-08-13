/**
 * IS THIS KEY TRYING TO BE A VERB? -- pure string work, no findings.
 *
 * Two questions, kept apart from the reporting so each can be reasoned about
 * (and tested) on its own: is an unrecognised key a NEAR-MISS on one the
 * registry knows, and does it at least READ like a relationship?
 *
 * Both are deliberately conservative. PRESERVE-UNKNOWN-KEYS is a promise the
 * board makes to the DONE-gate's `evidence_*` and everything like it; a matcher
 * that nags about `evidence_diffstat` gets the whole check switched off within a
 * day, and takes the typo detection -- the part that actually earns its keep --
 * down with it.
 */

import { LINKAGE_VERBS } from './card-linkage'

/** Keys the store owns that are not linkage -- never candidates for anything. */
export const STORE_KEYS = new Set(['title', 'status', 'priority', 'tags', 'created'])

/** First word of a key that reads as a relationship. Whole words only, so
 *  `created_by` (authorship, not linkage) stays quiet while `blocked_by`,
 *  `parent_card` and `supersedes` do not. */
export const RELATIONAL_WORDS = new Set([
  'after',
  'before',
  'belongs',
  'block',
  'blocked',
  'blocking',
  'blocks',
  'child',
  'children',
  'depend',
  'dependencies',
  'dependency',
  'depends',
  'dupe',
  'duplicate',
  'duplicates',
  'epic',
  'epics',
  'follows',
  'link',
  'linked',
  'links',
  'parent',
  'parents',
  'part',
  'precedes',
  'related',
  'relates',
  'relation',
  'replaced',
  'replaces',
  'see',
  'subtask',
  'subtasks',
  'supersedes',
  'superseded',
  'tracks',
])

/** Lowercase, separators gone, plural gone -- the form two spellings of the
 *  same intent collapse to. `depends-on`, `dependsOn` and `depends_ons` all
 *  reach `dependson`. */
function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[_\-\s]/g, '')
    .replace(/s$/, '')
}

/** One substitution, insertion or deletion apart. Cheaper and clearer than a
 *  full edit-distance matrix when the only answer wanted is "<= 1?". */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let edits = 0
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++
      j++
      continue
    }
    if (++edits > 1) return false
    if (short.length === long.length) i++
    j++
  }
  return edits + (long.length - j) <= 1
}

/**
 * The registered verb an unrecognised key was probably meant to be. Near-miss
 * matching only kicks in from five characters up: at four, `epic` is one edit
 * from `pic`, `epoc` and `epi`, and guessing there would be noise, not help.
 */
export function nearestVerb(key: string): string | undefined {
  const norm = normalizeKey(key)
  for (const verb of LINKAGE_VERBS) {
    const target = normalizeKey(verb.key)
    if (norm === target) return verb.key
    if (target.length >= 5 && withinOneEdit(norm, target)) return verb.key
  }
  return undefined
}

export function firstWord(key: string): string {
  return key.toLowerCase().split(/[_\-\s]/)[0]
}
