/**
 * `useWallFilter(rows, axes)` -- the one call a wall pane makes to obey the
 * shared filter.
 *
 * A pane declares the axes it understands and gets back its own rows, filtered.
 * Axes it did not declare are IGNORED, not applied (see `axes.ts`), so a pane
 * can never go blank because of a constraint it has no facet for.
 *
 * A pane wires this itself, in the file it already owns. That is deliberate:
 * `wall-filter-bus` never has to reach into eleven pane files to teach them the
 * filter, and a new pane obeys the wall by adding one line.
 */

import { useMemo, useRef } from 'react'
import { constrainsNothing, restrictToAxes, type WallAxis } from './axes'
import { useWallFilterStore } from './filter-store'
import { matchesWallRow, type WallRowFacets } from './query'

export interface WallFilterResult<T> {
  /** The rows that survived. Identity-preserved when nothing was filtered. */
  rows: readonly T[]
  /** `rows.length` -- what the pane shows. */
  matched: number
  /** What the pane would show with an empty box. `matched === total` = unfiltered. */
  total: number
}

/** Rows that already carry the facet names -- no projection needed. */
export function useWallFilter<T extends WallRowFacets>(
  rows: readonly T[],
  axes: readonly WallAxis[],
): WallFilterResult<T>
/** Rows in the pane's own shape, projected onto the grammar's facets. */
export function useWallFilter<T>(
  rows: readonly T[],
  axes: readonly WallAxis[],
  facets: (row: T) => WallRowFacets,
): WallFilterResult<T>
export function useWallFilter<T>(
  rows: readonly T[],
  axes: readonly WallAxis[],
  facets?: (row: T) => WallRowFacets,
): WallFilterResult<T> {
  const query = useWallFilterStore(s => s.query)

  // `axes` is a literal at almost every call site, so its identity churns every
  // render. The joined string is the real identity; the array is rebuilt from it
  // inside the memo so the dependency list stays honest.
  const axisKey = axes.join(',')

  // Same problem for the projection, which cannot be reduced to a string. Panes
  // write `r => ({ project: r.repo })` inline and that is the API we want, so
  // the latest one is read through a ref and never enters a dependency list. It
  // must be PURE -- a projection that closes over changing state will be read at
  // the next filter, not at the render that defined it.
  const facetsRef = useRef(facets)
  facetsRef.current = facets

  const scoped = useMemo(
    () => restrictToAxes(query, axisKey ? (axisKey.split(',') as WallAxis[]) : []),
    [query, axisKey],
  )

  return useMemo(() => {
    if (constrainsNothing(scoped)) return { rows, matched: rows.length, total: rows.length }
    const project = facetsRef.current
    const kept = rows.filter(row => matchesWallRow(project ? project(row) : (row as WallRowFacets), scoped))
    return { rows: kept, matched: kept.length, total: rows.length }
  }, [rows, scoped])
}
