/**
 * Barrel for THE WALL's filter substrate. A pane imports from here and nowhere
 * else in this folder.
 *
 * The grammar itself is NOT here -- it is pulse's, in `lib/pulse/`, re-exported
 * by `query.ts`. There is exactly one parser and one matcher in this tree.
 */

export { constrainsNothing, restrictToAxes, WALL_AXES, type WallAxis } from './axes'
export { selectWallProject, useWallFilterStore, type WallFilterState } from './filter-store'
export { projectToken } from './project-token'
export { matchesWallRow, parseWallQuery, type WallQuery, type WallRowFacets } from './query'
export { useWallFilter, type WallFilterResult } from './use-wall-filter'
