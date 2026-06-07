/**
 * Deterministic ordering for unordered pairs of opaque string keys (project URIs,
 * conversation ids). Collapses (a,b) and (b,a) to a single canonical pair/key so a
 * bidirectional link is stored once. Shared by project-links and conversation-links.
 */

/** Order two keys so (a,b) and (b,a) yield the same tuple. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/** Stable map key for an unordered pair (NUL-separated, collision-safe). */
export function pairKey(a: string, b: string): string {
  const [x, y] = orderedPair(a, b)
  return `${x}\0${y}`
}
