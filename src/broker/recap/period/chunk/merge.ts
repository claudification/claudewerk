/**
 * Deterministic <merge> stage for the chunked map-reduce path (Pillar A).
 *
 * Merges the per-chunk extraction outputs (each a RecapMetadata-shaped JSON)
 * into ONE merged RecapMetadata, in PURE CODE -- no LLM. This is the "facts
 * merge + dedup in code; prose/opinions get synthesized by Opus on the final
 * call" split (Jonas): string lists union, item lists concat + dedup by
 * norm(title)+first-commit, merging citations/detail across duplicates.
 *
 * Heavily unit-tested -- it is the deterministic heart of the reduce.
 */

import type { RecapItem, RecapMetadata } from '../../../../shared/protocol'

const SIMPLE_LIST_FIELDS = [
  'keywords',
  'hashtags',
  'goals',
  'discoveries',
  'side_effects',
  'open_questions',
  'stakeholders',
] as const
const ITEM_LIST_FIELDS = [
  'features',
  'bugs',
  'fixes',
  'incidents',
  'decisions',
  'dead_ends',
  'gotchas',
  'frustrations',
] as const

export function makeEmptyMetadata(): RecapMetadata {
  return {
    keywords: [],
    hashtags: [],
    goals: [],
    discoveries: [],
    side_effects: [],
    features: [],
    bugs: [],
    fixes: [],
    incidents: [],
    decisions: [],
    dead_ends: [],
    gotchas: [],
    frustrations: [],
    open_questions: [],
    stakeholders: [],
  }
}

/** Merge per-chunk extraction metadata into one. The reduce (CHUNKED:Final)
 *  then writes prose from this; subtitle here is only a fallback (Opus rewrites
 *  it), so we keep the first non-empty one. */
export function mergeMetadata(parts: RecapMetadata[]): RecapMetadata {
  const out = makeEmptyMetadata()
  const subtitle = parts.find(p => p.subtitle?.trim())?.subtitle
  if (subtitle) out.subtitle = subtitle
  for (const field of SIMPLE_LIST_FIELDS) {
    out[field] = unionStrings(parts.flatMap(p => p[field] ?? []))
  }
  for (const field of ITEM_LIST_FIELDS) {
    out[field] = dedupItems(parts.flatMap(p => p[field] ?? []))
  }
  return out
}

/** Case-sensitive, order-preserving union (trims, drops empties). Keeps the
 *  first-seen casing so canonical terms/hashtags survive verbatim. */
export function unionStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const v = raw.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** Dedup key for an item: normalized title + first commit hash. Two items that
 *  share a title but cite different first commits are kept distinct. */
export function itemDedupKey(item: RecapItem): string {
  return `${normTitle(item.title)}|${item.commits?.[0]?.toLowerCase() ?? ''}`
}

function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Concat + dedup items by itemDedupKey, merging citations + detail across
 *  duplicates. First occurrence wins position; later dupes enrich it. */
export function dedupItems(items: RecapItem[]): RecapItem[] {
  const byKey = new Map<string, RecapItem>()
  const order: string[] = []
  for (const item of items) {
    if (!item.title?.trim()) continue
    const key = itemDedupKey(item)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...item })
      order.push(key)
    } else {
      byKey.set(key, mergeItem(existing, item))
    }
  }
  return order.map(k => byKey.get(k) as RecapItem)
}

/** Merge two same-key items: union conversations + commits, keep the longer
 *  detail, and downgrade to inferred only if BOTH are inferred (a fact from any
 *  chunk wins -- never present merged inference as fact-free). */
// fallow-ignore-next-line complexity
function mergeItem(a: RecapItem, b: RecapItem): RecapItem {
  const detail = (b.detail?.length ?? 0) > (a.detail?.length ?? 0) ? b.detail : a.detail
  const conversations = unionStrings([...(a.conversations ?? []), ...(b.conversations ?? [])])
  const commits = unionStrings([...(a.commits ?? []), ...(b.commits ?? [])])
  const inferred = Boolean(a.inferred) && Boolean(b.inferred)
  const outcome = mergeOutcome(a.outcome, b.outcome)
  return {
    title: a.title,
    ...(detail ? { detail } : {}),
    ...(conversations.length ? { conversations } : {}),
    ...(commits.length ? { commits } : {}),
    ...(inferred ? { inferred: true } : {}),
    ...(outcome ? { outcome } : {}),
  }
}

/** Reconcile two tech-discovered outcomes across a dedup merge: agreement keeps
 *  the verdict; any disagreement (or an existing 'mixed') collapses to 'mixed'.
 *  Used by the Lessons Scavenger so the cross-project tech registry reflects
 *  "worked in one place, failed in another" honestly. */
export function mergeOutcome(a: RecapItem['outcome'], b: RecapItem['outcome']): RecapItem['outcome'] {
  if (!a) return b
  if (!b) return a
  if (a === b) return a
  return 'mixed'
}
