/**
 * THE WALL's filter state -- ONE store, held OUTSIDE the surface's component
 * tree.
 *
 * THE WALL is a managed surface: it moves between `inline`, `docked`,
 * `detached` and ambient, and every one of those transitions unmounts and
 * remounts the tree. State that lived in a provider would be lost on each move
 * and would need a save/restore dance around every transition -- the kind of
 * bookkeeping that works until the fourth caller forgets it. A module-scope
 * store survives all four BY CONSTRUCTION: nothing in the transition path can
 * reach it, so nothing in the transition path can drop it.
 *
 * The raw string and the parsed query are kept together and written together,
 * so they can never disagree. The parse happens once per keystroke here rather
 * than once per pane per render, and `query` keeps a stable identity between
 * writes -- eleven `useWallFilter` memos depend on it.
 *
 * Per `feedback_zustand_no_object_selectors`, select ONE field at a time:
 * `useWallFilterStore(s => s.query)`, never `s => ({ raw, query })`.
 */

import { create } from 'zustand'
import { toggledProject, withProject } from './project-token'
import { parseWallQuery, type WallQuery } from './query'

export interface WallFilterState {
  /** Exactly what is in the header box. */
  raw: string
  /** `raw`, parsed. Stable identity until the next write. */
  query: WallQuery
  /** Write the box. A no-op write keeps `query` identical, so nothing re-renders. */
  setRaw(raw: string): void
  /** Empty the box. */
  clear(): void
  /**
   * THE CHIP ACTION. Scope to a project, or clear the scope when that same
   * project is already the one scoped. Owned here and exported once --
   * `wall-navigation-and-hover` CONSUMES this and must not grow a second one.
   */
  toggleProject(project: string): void
  /** Set or clear the project scope outright, no toggle. */
  setProject(project: string | null): void
}

export const useWallFilterStore = create<WallFilterState>((set, get) => ({
  raw: '',
  query: parseWallQuery(''),

  setRaw: raw => {
    // Re-parsing an unchanged string would hand every pane a fresh query object
    // and re-filter the whole wall for nothing. A controlled input echoes its
    // own value constantly, so this guard is load-bearing, not defensive.
    if (get().raw === raw) return
    set({ raw, query: parseWallQuery(raw) })
  },

  clear: () => get().setRaw(''),
  toggleProject: project => get().setRaw(toggledProject(get().raw, project)),
  setProject: project => get().setRaw(withProject(get().raw, project)),
}))

/** The project currently scoped, or null. A primitive, so it is selector-safe. */
export const selectWallProject = (s: WallFilterState): string | null => s.query.project
