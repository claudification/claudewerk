/**
 * AXES -- the mechanism that makes "a pane stays full rather than going blank"
 * an API guarantee instead of eleven separate good intentions.
 *
 * The wall has ONE query box and eleven panes that understand different things.
 * A commit river knows nothing about context pressure; typing `%70` must leave
 * it showing every commit, not zero. The naive wiring (every pane runs the whole
 * query and hopes its rows happen to carry the field) fails exactly backwards:
 * a missing facet reads as "does not satisfy the constraint", so the pane goes
 * blank and the user thinks the fleet is empty.
 *
 * So a pane declares the axes it understands, and every axis it did NOT declare
 * is CLEARED OUT OF THE QUERY before a row is looked at. The pane cannot express
 * the wrong behaviour because it never sees the constraint. An empty pane on the
 * wall therefore always means "nothing here matched a filter this pane
 * understands" -- the one reading that is worth having.
 *
 * Each axis owns its positive field AND its `-x` exclusion bucket, because an
 * exclusion is the same axis wearing a minus sign: `-@anvil` on a pane that does
 * not understand projects must drop nothing.
 */

import { isEmptyQuery } from '@/lib/pulse/filter'
import type { WallQuery } from './query'

/** One axis per sigil in the grammar. */
export type WallAxis =
  /** free text over title / project / action / tag */
  | 'text'
  /** `!` `!!` `!!!` band shorthand */
  | 'band'
  /** `@proj` */
  | 'project'
  /** `#tag` */
  | 'tag'
  /** `~30m` */
  | 'time'
  /** `$1` */
  | 'cost'
  /** `%80` */
  | 'context'
  /** `&host` */
  | 'host'
  /** `:opus` */
  | 'model'
  /** `+over` / `+only` -- machine-dispatched rows */
  | 'managed'

/** Every axis, for the panes that genuinely understand the whole grammar. */
export const WALL_AXES: readonly WallAxis[] = [
  'text',
  'band',
  'project',
  'tag',
  'time',
  'cost',
  'context',
  'host',
  'model',
  'managed',
] as const

/**
 * Reset one axis to the value that constrains NOTHING.
 *
 * `managed` is the one that is not simply `null`: the grammar's default is to
 * HIDE machine-dispatched rows, so its neutral value is `includeManaged: true`.
 * Leaving it false would silently drop managed rows from a pane that never
 * declared it understood the concept -- the exact blank-pane failure this file
 * exists to prevent, arriving through the back door.
 */
const CLEAR_AXIS: Record<WallAxis, (q: WallQuery) => void> = {
  text: q => {
    q.text = ''
    q.not.text = []
  },
  band: q => {
    q.bands = null
    q.not.bands = []
  },
  project: q => {
    q.project = null
    q.not.projects = []
  },
  tag: q => {
    q.tag = null
    q.not.tags = []
  },
  time: q => {
    q.windowMs = null
  },
  cost: q => {
    q.minCostUsd = null
  },
  context: q => {
    q.minContextPct = null
  },
  host: q => {
    q.host = null
    q.not.hosts = []
  },
  model: q => {
    q.model = null
    q.not.models = []
  },
  managed: q => {
    q.includeManaged = true
    q.onlyManaged = false
  },
}

/**
 * The query as a pane that understands only `axes` sees it. Undeclared axes are
 * IGNORED, not applied. Never mutates the input -- the store's parsed query is
 * shared by every pane on the wall.
 */
export function restrictToAxes(query: WallQuery, axes: readonly WallAxis[]): WallQuery {
  const declared = new Set(axes)
  // Deep enough: `not` and each of its buckets are replaced, never mutated in
  // place, so the store's query object is untouched.
  const scoped: WallQuery = { ...query, not: { ...query.not } }
  for (const axis of WALL_AXES) {
    if (!declared.has(axis)) CLEAR_AXIS[axis](scoped)
  }
  return scoped
}

/**
 * True when this (already axis-restricted) query removes no row at all, so the
 * caller can hand back its input array untouched instead of allocating a copy.
 *
 * Not the same as `isEmptyQuery`: after restriction, `includeManaged` is `true`
 * on almost every pane, which `isEmptyQuery` reads as a constraint. Here it is
 * the opposite -- `includeManaged` means nothing is being hidden. When it is
 * FALSE the pane declared `managed` and the hide-by-default rule IS live, so
 * this is never the no-op case.
 */
export function constrainsNothing(query: WallQuery): boolean {
  if (!query.includeManaged || query.onlyManaged) return false
  return isEmptyQuery({ ...query, includeManaged: false })
}
