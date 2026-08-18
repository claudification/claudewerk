import type { PulseExclusions, PulseQuery, PulseSearchable } from './query-types'

function hasExclusions(not: PulseExclusions): boolean {
  return Object.values(not).some(list => list.length > 0)
}

/** True when the query constrains nothing — used to decide "show the whole fleet". */
export function isEmptyQuery(q: PulseQuery): boolean {
  return (
    !q.text &&
    !q.bands &&
    !q.project &&
    !q.tag &&
    !q.host &&
    !q.model &&
    q.windowMs === null &&
    q.minCostUsd === null &&
    q.minContextPct === null &&
    !hasExclusions(q.not)
  )
}

/** Case-insensitive "field contains needle", false when the field is absent.
 *  Absent is never a wildcard: `&studio` must not match an unknown host. */
function has(field: string | undefined, needle: string): boolean {
  return (field ?? '').toLowerCase().includes(needle)
}

/** Everything a free-text term searches, lowercased once. */
function haystack(row: PulseSearchable): string {
  return `${row.title} ${row.project} ${row.action} ${row.tag ?? ''}`.toLowerCase()
}

/** `-x` rejects before anything else — an exclusion always wins over a match. */
function isExcluded(row: PulseSearchable, not: PulseExclusions): boolean {
  if (not.bands.includes(row.band)) return true
  if (not.projects.some(p => has(row.project, p))) return true
  if (not.tags.some(t => has(row.tag, t))) return true
  if (not.hosts.some(h => has(row.host, h))) return true
  if (not.models.some(m => has(row.model, m))) return true
  if (not.text.length) {
    const hay = haystack(row)
    if (not.text.some(word => hay.includes(word))) return true
  }
  return false
}

/**
 * One constraint per entry: `applies` says whether the query set it, `holds`
 * says whether the row satisfies it. A list rather than a chain of ifs so
 * adding a sigil is one line and the function stays flat.
 */
const CONSTRAINTS: Array<{
  applies: (q: PulseQuery) => boolean
  holds: (row: PulseSearchable, q: PulseQuery) => boolean
}> = [
  { applies: q => q.bands !== null, holds: (row, q) => !!q.bands?.includes(row.band) },
  { applies: q => q.project !== null, holds: (row, q) => has(row.project, q.project ?? '') },
  { applies: q => q.tag !== null, holds: (row, q) => has(row.tag, q.tag ?? '') },
  { applies: q => q.host !== null, holds: (row, q) => has(row.host, q.host ?? '') },
  { applies: q => q.model !== null, holds: (row, q) => has(row.model, q.model ?? '') },
  { applies: q => q.windowMs !== null, holds: (row, q) => row.ageMs <= (q.windowMs ?? 0) },
  { applies: q => q.minCostUsd !== null, holds: (row, q) => (row.costUsd ?? 0) >= (q.minCostUsd ?? 0) },
  { applies: q => q.minContextPct !== null, holds: (row, q) => (row.contextPct ?? 0) >= (q.minContextPct ?? 0) },
  { applies: q => q.text !== '', holds: (row, q) => matchesText(row, q.text) },
]

function matchesText(row: PulseSearchable, text: string): boolean {
  const hay = haystack(row)
  return text.split(' ').every(word => hay.includes(word))
}

export function matchesPulseQuery(row: PulseSearchable, q: PulseQuery): boolean {
  if (isExcluded(row, q.not)) return false
  return CONSTRAINTS.every(c => !c.applies(q) || c.holds(row, q))
}

/** Range of the first free-text hit inside `text`, for highlighting. */
export function highlightRange(text: string, q: PulseQuery): [number, number] | null {
  if (!q.text) return null
  const first = q.text.split(' ')[0]
  if (!first) return null
  const i = text.toLowerCase().indexOf(first)
  return i < 0 ? null : [i, i + first.length]
}
