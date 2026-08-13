/**
 * Getting linkage OUT of a frontmatter bag, and back into one.
 *
 * The registry (card-linkage.ts) says which verbs exist; this says what a
 * card's raw `meta` means once you apply them. Two jobs, both about SPELLING
 * and never about targets:
 *
 *   readLinkage        disk shape  -> one bag keyed by storage key
 *   normalizeLinkageMeta  any shape -> the one form that reaches disk
 *
 * Both are total. A key with the wrong shape is coerced rather than dropped,
 * because dropping is what the old hand-written `Array.isArray(meta.depends_on)
 * ? ... : undefined` did, and a linkage key that silently reads as nothing is
 * the precise failure this whole area exists to end. The doctor still reports
 * the shape (`linkage-arity`) -- being forgiving and being quiet are different
 * things, and only the first one is a kindness.
 */

import { LINKAGE_VERBS, storageKey } from './card-linkage'

/** One card's linkage, aliases folded and arity coerced. Keyed by STORAGE key,
 *  so a reader never has to know which spelling the file used. */
export type CardLinkage = Record<string, string[]>

/** A frontmatter value as a list of non-empty strings, whatever shape it had. */
function asList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value]
  return raw.filter(v => v !== null && v !== undefined && v !== '').map(String)
}

/**
 * Read every registered verb off a raw frontmatter bag, folding aliases into
 * their stored key. Values are de-duplicated but otherwise untouched.
 */
export function readLinkage(meta: Record<string, unknown>): CardLinkage {
  const out: CardLinkage = {}
  for (const verb of LINKAGE_VERBS) {
    const value = meta[verb.key]
    if (value === undefined || value === null || value === '') continue
    const key = storageKey(verb)
    out[key] = [...new Set([...(out[key] ?? []), ...asList(value)])]
  }
  return out
}

/** One value for a `one`-arity verb: the first, since a list there is already
 *  reported as a shape problem and picking the first beats joining them into a
 *  garbage id (`String(['a','b'])` === `'a,b'`, which is what happens today). */
export function readOne(linkage: CardLinkage, key: string): string | undefined {
  return linkage[key]?.[0]
}

/**
 * Normalise a frontmatter bag for WRITING: every alias collapses onto its
 * stored key and the alias spelling is dropped, so the file that comes back has
 * exactly one form of each fact. Everything the registry does not own is
 * returned untouched -- PRESERVE-UNKNOWN-KEYS still holds.
 */
export function normalizeLinkageMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const aliases = LINKAGE_VERBS.filter(v => v.storedAs && meta[v.key] !== undefined && meta[v.key] !== null)
  if (aliases.length === 0) return meta

  const out = { ...meta }
  for (const alias of aliases) {
    const target = alias.storedAs as string
    const merged = [...new Set([...asList(out[target]), ...asList(out[alias.key])])]
    delete out[alias.key]
    if (merged.length > 0) out[target] = merged
  }
  return out
}
