/**
 * Barrel for THE WALL's filter substrate. A pane imports from here and nowhere
 * else in this folder.
 *
 * The grammar itself is NOT here -- it is pulse's, in `lib/pulse/`, re-exported
 * by `query.ts`. There is exactly one parser and one matcher in this tree.
 *
 * THE TIME CURSOR IS NOT RE-EXPORTED HERE, and that is not an oversight. A pane
 * does not wire the cursor: `useWallFilter` applies it from inside this barrel's
 * own hook, so there is nothing for a pane to import. The two surfaces that DO
 * render the cursor (`wall-scrubber`, `wall-pane`) and the two panes that answer
 * it themselves (S1, S2) take `use-wall-cursor` directly, which keeps this file
 * about the one thing its name says.
 */

export { constrainsNothing, restrictToAxes, WALL_AXES, type WallAxis } from './axes'
export { selectWallDay, selectWallProject, useWallFilterStore, type WallFilterState } from './filter-store'
export { projectToken } from './project-token'
export { matchesWallRow, parseWallQuery, type WallQuery, type WallRowFacets } from './query'
export { useWallFilter, type WallFilterResult } from './use-wall-filter'
