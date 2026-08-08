/**
 * Home-relative display paths.
 *
 * Six components had inlined the same `/^\/Users\/[^/]+/ -> '~'` replace, which
 * is how the fork dialog ended up showing `~/projects/x` in its header and
 * `/Users/jonas/projects/x` in a field two rows below it. One derivation, so
 * the whole panel abbreviates the same way.
 *
 * DISPLAY ONLY. Never send a shortened path over the wire -- the sentinel owns
 * path resolution and expects a real path (or a project URI).
 */

const HOME_PREFIX = /^(?:\/Users|\/home)\/[^/]+(?=\/|$)/

export function shortenHomePath(path: string): string {
  return path.replace(HOME_PREFIX, '~')
}

/** Undo `shortenHomePath` for a value the user may have typed with a `~`. */
export function expandHomePath(path: string, home: string): string {
  if (path === '~') return home
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path
}
