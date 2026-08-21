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
    !q.workspace &&
    q.windowMs === null &&
    q.day === null &&
    q.minCostUsd === null &&
    q.minContextPct === null &&
    !q.includeManaged &&
    !q.onlyManaged &&
    !hasExclusions(q.not)
  )
}

/** Case-insensitive "field contains needle", false when the field is absent.
 *  Absent is never a wildcard: `&studio` must not match an unknown host. */
function has(field: string | undefined, needle: string): boolean {
  return (field ?? '').toLowerCase().includes(needle)
}

/**
 * Drop the separators, so `^client-work` finds the workspace called
 * "Client Work".
 *
 * The other string axes never need this: a project, a host and a model are all
 * already token-shaped, because they come from a path segment, a sentinel alias
 * or a model id. A WORKSPACE name is free prose the user typed into the sidebar,
 * and the tokenizer splits the query on whitespace — so without this, a
 * two-word workspace would be unreachable from the one box that is supposed to
 * reach everything.
 */
function slug(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '')
}

/** True when ANY of the row's workspaces contains the needle. Membership is
 *  many-to-many; a row in five workspaces answers to all five. */
function inWorkspace(row: PulseSearchable, needle: string): boolean {
  const want = slug(needle)
  if (!want) return false
  return (row.workspaces ?? []).some(name => slug(name).includes(want))
}

/**
 * `YYYY-MM-DD` as the READER's own calendar reads that instant.
 *
 * Local parts, never `toISOString()`: the ISO form is UTC, so a Bangkok evening
 * lands on tomorrow's square and the `~day` filter would then hand back a
 * different set of rows than the square the reader clicked. This is the browser
 * half of the same rule the fold obeys on the server.
 */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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
  if (not.workspaces.some(w => inWorkspace(row, w))) return true
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
  // Managed rows are machine-dispatched, so they are OUT unless asked for --
  // Pulse answers "what am I working on", not "what is the fleet running".
  { applies: q => !q.includeManaged, holds: row => !row.managed },
  { applies: q => q.onlyManaged, holds: row => !!row.managed },
  { applies: q => q.bands !== null, holds: (row, q) => !!q.bands?.includes(row.band) },
  { applies: q => q.project !== null, holds: (row, q) => has(row.project, q.project ?? '') },
  { applies: q => q.tag !== null, holds: (row, q) => has(row.tag, q.tag ?? '') },
  { applies: q => q.host !== null, holds: (row, q) => has(row.host, q.host ?? '') },
  { applies: q => q.model !== null, holds: (row, q) => has(row.model, q.model ?? '') },
  { applies: q => q.workspace !== null, holds: (row, q) => inWorkspace(row, q.workspace ?? '') },
  { applies: q => q.windowMs !== null, holds: (row, q) => row.ageMs <= (q.windowMs ?? 0) },
  // A row carries an AGE, not an instant, so the day it fell on is recovered
  // against the clock at match time. At day granularity the sub-second drift
  // between the render that measured the age and this call is invisible except
  // in the last instant before local midnight, where it can only ever move a row
  // by one square -- and the alternative, threading a timestamp through every
  // pane's facets, is a change to thirteen files for that one instant.
  { applies: q => q.day !== null, holds: (row, q) => localDayKey(Date.now() - row.ageMs) === q.day },
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
