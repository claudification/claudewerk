/**
 * What each Quick Task trigger offers, scored against the typed query.
 *
 * Pure and backend-free so the grammar can be tested without CodeMirror: the
 * editor source just renders whatever comes back. Every builder returns the
 * same row shape, so the popup has one renderer for four different triggers.
 */

import { SYSTEM_TAGS } from '@shared/board-system-tags'
import { buildEpicIndex, type EpicRollup } from '@shared/epic-cards'
import { DROPDOWN_MODEL_ENTRIES } from '@shared/models'
import { fuzzyScore } from '@/components/input-editor/autocomplete-shared'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { boardTags, PRIORITIES, type ProjectOption, type ScanKind } from './task-tokens'

export interface TokenCandidate {
  /** The value written to frontmatter (a card id, a priority, a tag). */
  value: string
  /** Left column in the popup. */
  label: string
  /** Right column -- title, progress, status. */
  detail?: string
}

const MAX_ROWS = 12

/** Rank by fuzzy score against a haystack, keep the top rows. */
function rank<T>(items: readonly T[], query: string, haystack: (item: T) => string, row: (item: T) => TokenCandidate) {
  const scored: Array<{ row: TokenCandidate; score: number }> = []
  for (const item of items) {
    const score = query ? fuzzyScore(query, haystack(item)) : 1
    if (score > 0) scored.push({ row: row(item), score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, MAX_ROWS).map(s => s.row)
}

/** `4/11` plus a bar, or the card's own status when it has no children yet. */
function epicDetail(rollup: EpicRollup): string {
  const title = rollup.card?.title ?? rollup.epicId
  if (rollup.total === 0) return title
  return `${title} -- ${rollup.done}/${rollup.total}`
}

function epicRows(tasks: readonly ProjectTaskMeta[], query: string): TokenCandidate[] {
  const rollups = [...buildEpicIndex(tasks).values()]
  return rank(
    rollups,
    query,
    r => `${r.epicId} ${r.card?.title ?? ''}`,
    r => ({ value: r.epicId, label: r.epicId, detail: epicDetail(r) }),
  )
}

/**
 * Cards for `+depends-on` / `&relates-to`.
 *
 * Archived cards are excluded: pointing a live card's sequencing at something
 * already filed away is never what was meant, and they are the bulk of an old
 * board's rows -- leaving them in would bury the live matches.
 */
function cardRows(tasks: readonly ProjectTaskMeta[], query: string): TokenCandidate[] {
  const live = tasks.filter(t => t.status !== 'archived')
  return rank(
    live,
    query,
    t => `${t.slug} ${t.title}`,
    t => ({ value: t.slug, label: t.slug, detail: `${t.title} -- ${t.status}` }),
  )
}

/**
 * Models for `:`.
 *
 * DRAWN FROM THE SPAWN DROPDOWN, not from every slug CC accepts. `ALL_CC_SLUGS`
 * has forty-odd entries including four spellings of the same Opus and two
 * dynamic aliases that resolve to a different family every week -- a picker is
 * where you choose, and a list nobody can read is a list you scroll past. The
 * dropdown rows are the curated set the Spawn/Run surface already offers, so the
 * two places you pick a model offer the same models.
 */
function modelRows(query: string): TokenCandidate[] {
  return rank(
    DROPDOWN_MODEL_ENTRIES,
    query,
    m => `${m.id} ${m.label}`,
    m => ({ value: m.id, label: m.id, detail: m.info }),
  )
}

function priorityRows(query: string): TokenCandidate[] {
  return rank(
    PRIORITIES,
    query,
    p => p,
    p => ({ value: p, label: p }),
  )
}

/**
 * Tags. The KEPT token -- accepting completes the word rather than eating it.
 *
 * SYSTEM TAGS COME FIRST, IN REGISTRY ORDER, and are deliberately NOT fuzzy-
 * sorted against each other: a routing tag's position should be somewhere the
 * hand can learn, not somewhere the scorer moved it to this keystroke. Board
 * tags follow, fuzzy-ranked, with any system tag already shown filtered out so
 * a tag in use on the board cannot appear twice.
 *
 * This is what replaced the `Mod-Enter` shortcut for `#needs-refine`: a
 * keybinding nobody can see is worse than a list entry everybody can, and it
 * works on a touchscreen, where there is no Cmd key at all.
 */
function tagRows(tasks: readonly ProjectTaskMeta[], query: string): TokenCandidate[] {
  const system = SYSTEM_TAGS.flatMap(s =>
    !query || fuzzyScore(query, s.tag) > 0 ? [{ value: s.tag, label: `#${s.tag}`, detail: s.detail }] : [],
  )
  const shown = new Set(system.map(s => s.value))
  const board = rank(
    boardTags(tasks).filter(t => !shown.has(t)),
    query,
    t => t,
    t => ({ value: t, label: `#${t}` }),
  )
  return [...system, ...board].slice(0, MAX_ROWS)
}

/** Projects the capture can be re-filed into. Matched on name AND path. */
function projectRows(projects: readonly ProjectOption[], query: string): TokenCandidate[] {
  return rank(
    projects,
    query,
    p => `${p.name} ${p.path}`,
    p => ({ value: p.uri, label: p.name, detail: p.path }),
  )
}

/** What a trigger draws from. Kept as one bag so the popup has one call site. */
export interface CandidateSources {
  tasks: readonly ProjectTaskMeta[]
  projects: readonly ProjectOption[]
}

/**
 * Rows for a trigger. `tag` is not a `ScanKind` because it sets no chip and is
 * never eaten -- it is routed here so all seven triggers share one popup.
 *
 * A strategy map rather than a chain: seven branches on one key is exactly the
 * shape the covenant names.
 */
const ROWS: Record<ScanKind | 'tag', (src: CandidateSources, q: string) => TokenCandidate[]> = {
  epic: (src, q) => epicRows(src.tasks, q),
  priority: (_src, q) => priorityRows(q),
  dependsOn: (src, q) => cardRows(src.tasks, q),
  relatesTo: (src, q) => cardRows(src.tasks, q),
  model: (_src, q) => modelRows(q),
  project: (src, q) => projectRows(src.projects, q),
  tag: (src, q) => tagRows(src.tasks, q),
}

export function candidatesFor(kind: ScanKind | 'tag', src: CandidateSources, query: string): TokenCandidate[] {
  return ROWS[kind](src, query)
}
