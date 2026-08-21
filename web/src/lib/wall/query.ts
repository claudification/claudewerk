/**
 * THE WALL's view of the filter grammar.
 *
 * There is exactly ONE parser and ONE matcher in this tree and BOTH live in
 * `lib/pulse/`. This file does not fork them, does not move them and does not
 * wrap their logic -- it re-exports them under wall-shaped names and adds the
 * one thing the wall needs that pulse does not: a PARTIAL row.
 *
 * Why partial. `PulseSearchable` requires `title`, `project`, `action`, `ageMs`
 * and `band` because every pulse row is a conversation and always has all five.
 * A wall pane is a commit, a card move, a host, a spend bucket -- most of them
 * carry three of those fields at best. `WallRowFacets` is the same shape with
 * every field optional, and `toSearchable` fills the gaps with values that can
 * only ever KEEP a row: empty strings match nothing but are searched harmlessly,
 * `ageMs: 0` reads as "brand new" so a `~30m` window never drops a row for
 * having no clock, and `band: 'idle'` is the band that no shorthand selects.
 *
 * A pane never has to invent a facet it does not have. It declares the axes it
 * understands (see `axes.ts`) and the ones it does not are stripped from the
 * query before a row is ever looked at, so an absent facet is never read.
 */

import type { PulseBand } from '@/lib/pulse/bands'
import { matchesPulseQuery, type PulseQuery, type PulseSearchable, parsePulseQuery } from '@/lib/pulse/filter'

/** The wall query IS the pulse query. One grammar, one type. */
export type WallQuery = PulseQuery

/** The wall parser IS the pulse parser. Re-exported, never re-implemented. */
export const parseWallQuery: (raw: string) => WallQuery = parsePulseQuery

/**
 * Everything a wall row can offer the grammar. Every field optional -- a pane
 * supplies only the facets it actually has, and only the axes it declares are
 * ever consulted.
 */
export interface WallRowFacets {
  /** Free-text haystack, part 1. */
  title?: string
  /** `@` axis. */
  project?: string
  /** Free-text haystack, part 2 -- what the row is DOING. */
  action?: string
  /** `#` axis, also part of the free-text haystack. */
  tag?: string
  /** `~` axis -- age in ms at match time. */
  ageMs?: number
  /** `!` axis. */
  band?: PulseBand
  /** `$` axis. */
  costUsd?: number
  /** `%` axis. */
  contextPct?: number
  /** `&` axis. */
  host?: string
  /** `:` axis. */
  model?: string
  /**
   * `^` axis -- every workspace this row's project sits in, by name.
   *
   * A pane never fills this in. Workspace membership is not on the row, it is on
   * the project tree, so `useWallFilter` resolves it from `project` through the
   * workspace index and hands it to the matcher. Declaring the axis is the whole
   * of a pane's part in it -- see `axes.ts`.
   */
  workspaces?: readonly string[]
  /** `+over` axis -- machine-dispatched provenance. */
  managed?: boolean
}

/** Fill a partial row out to what the matcher expects. See the file header for
 *  why each default is the row-KEEPING one. */
function toSearchable(f: WallRowFacets): PulseSearchable {
  return {
    title: f.title ?? '',
    project: f.project ?? '',
    action: f.action ?? '',
    tag: f.tag,
    ageMs: f.ageMs ?? 0,
    band: f.band ?? 'idle',
    costUsd: f.costUsd,
    contextPct: f.contextPct,
    host: f.host,
    model: f.model,
    // NOT defaulted to a keeping value: an absent workspace list means "in no
    // workspace", which is a real answer, and `^eng` must not match it. Same
    // rule as `host` and `model` -- absent is never a wildcard. A pane that has
    // no workspace to resolve never sees the axis at all.
    workspaces: f.workspaces,
    managed: f.managed,
  }
}

/** The wall matcher IS the pulse matcher, given a partial row. */
export function matchesWallRow(facets: WallRowFacets, query: WallQuery): boolean {
  return matchesPulseQuery(toSearchable(facets), query)
}
