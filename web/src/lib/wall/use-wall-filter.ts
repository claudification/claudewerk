/**
 * `useWallFilter(rows, axes)` -- the one call a wall pane makes to obey the
 * shared filter AND the shared time cursor.
 *
 * A pane declares the axes it understands and gets back its own rows, filtered.
 * Axes it did not declare are IGNORED, not applied (see `axes.ts`), so a pane
 * can never go blank because of a constraint it has no facet for.
 *
 * A pane wires this itself, in the file it already owns. That is deliberate:
 * `wall-filter-bus` never has to reach into eleven pane files to teach them the
 * filter, and a new pane obeys the wall by adding one line.
 *
 * THE TIME CURSOR RIDES THE SAME CALL, and that is the whole of W1's "every pane
 * obeys" guarantee. The alternative -- a second hook each pane also has to
 * remember -- makes "a pane that ignores the cursor is a bug" a rule somebody
 * enforces by reading thirteen files. Here it is not expressible: a pane that
 * filters at all is already rewound.
 *
 * WHICH PANES THE CURSOR REACHES IS THE `time` AXIS, not a second list. A pane
 * declares `time` exactly when its rows carry an age the grammar can read, and
 * an age is the only thing that answers "was this row already here at T-42m".
 * A pane that did not declare it has no clock per row, so it is not narrowed --
 * it is BLIND to the cursor, and the chrome says so rather than showing live
 * numbers under a rewound header (see `wall-pane.tsx`).
 *
 * THE `^workspace` AXIS IS RESOLVED HERE TOO, for the same reason. Workspace
 * membership is not a field on any row -- it is on the project tree, one tier
 * up -- so a pane cannot supply it and is never asked to. A pane declares the
 * axis, and this hook turns its `project` facet into the list of workspaces that
 * hold it (`workspace-index.ts`) at match time. Making it a pane's job would be
 * ten more files reaching into the sidebar's order store for one boolean.
 */

import { useMemo, useRef } from 'react'
import { useWorkspaceIndex, type WorkspaceIndex } from '@/lib/workspace-index'
import { constrainsNothing, restrictToAxes, type WallAxis } from './axes'
import { existedAtCursor } from './cursor'
import { useWallCursorStore } from './cursor-store'
import { useWallFilterStore } from './filter-store'
import { matchesWallRow, type WallQuery, type WallRowFacets } from './query'

/** No workspaces, one shared identity -- the answer for every project the
 *  sidebar has not filed anywhere, which on most fleets is most of them. */
const NO_WORKSPACES: readonly string[] = []

/** True when the (already restricted) query asks about workspaces at all. When
 *  false, nothing looks the index up and the axis costs nothing. */
function readsWorkspace(query: WallQuery): boolean {
  return query.workspace !== null || query.not.workspaces.length > 0
}

/** The row's facets with its workspaces filled in from the index. */
function withWorkspaces(facets: WallRowFacets, index: WorkspaceIndex): WallRowFacets {
  return { ...facets, workspaces: index.byProject.get(facets.project ?? '') ?? NO_WORKSPACES }
}

export interface WallFilterResult<T> {
  /** The rows that survived. Identity-preserved when nothing was filtered. */
  rows: readonly T[]
  /** `rows.length` -- what the pane shows. */
  matched: number
  /** What the pane would show with an empty box AT THE CURSOR.
   *  `matched === total` = unfiltered. */
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
  const offsetMs = useWallCursorStore(s => s.offsetMs)
  const workspaces = useWorkspaceIndex()

  // `axes` is a literal at almost every call site, so its identity churns every
  // render. The joined string is the real identity; the array is rebuilt from it
  // inside the memo so the dependency list stays honest.
  const axisKey = axes.join(',')

  // Whether this pane has a per-row clock the cursor can read. A boolean, so it
  // is a stable dependency where the array it came from is not.
  const tracksTime = axes.includes('time')

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

  // THE CURSOR RUNS FIRST, and `total` is measured after it. `{matched}/{total}`
  // then keeps meaning "of what this pane HAS at the offset you are looking at",
  // which is the reading every pane's empty line already promises. Counting
  // against the live row set instead would print `3/40` on a rewound wall where
  // 37 of those 40 had not happened yet.
  const atCursor = useMemo(() => {
    if (offsetMs <= 0 || !tracksTime) return rows
    const project = facetsRef.current
    return rows.filter(row => existedAtCursor((project ? project(row) : (row as WallRowFacets)).ageMs, offsetMs))
  }, [rows, offsetMs, tracksTime])

  return useMemo(() => {
    if (constrainsNothing(scoped)) return { rows: atCursor, matched: atCursor.length, total: atCursor.length }
    const project = facetsRef.current
    // The index is consulted ONLY when the query mentions a workspace, so a pane
    // that declared the axis pays nothing for it on every other query.
    const resolve = readsWorkspace(scoped)
    const kept = atCursor.filter(row => {
      const facet = project ? project(row) : (row as WallRowFacets)
      return matchesWallRow(resolve ? withWorkspaces(facet, workspaces) : facet, scoped)
    })
    return { rows: kept, matched: kept.length, total: atCursor.length }
  }, [atCursor, scoped, workspaces])
}
