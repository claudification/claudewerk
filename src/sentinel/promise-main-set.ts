/**
 * EVERY COMMIT REACHABLE FROM THE BASE, ASKED ONCE.
 *
 * `merge-base --is-ancestor <sha> main` is the exactly-right question and the
 * exactly-wrong shape to ask 200 times: two `git` spawns per sha, ~40ms each, so
 * a board's worth of promises costs seconds and the resolver grew a
 * `MAX_RESOLVED_SHAS` cap to bound it. That cap is what this module exists to
 * delete. It answered `could not verify` for every sha past the 200th, and this
 * repo's board reached 204 on 2026-08-22 -- four cards whose commits are all
 * ancestors of main rendered in the loud red table, which is the FALSE
 * ACCUSATION `promise-git.ts` calls the end of the feature.
 *
 * `git rev-list <base>` answers for all of them in ONE spawn. 3,800 commits is
 * ~150KB of text and a 3,800-entry Set; a repo two orders of magnitude larger
 * would still be cheaper than 200 spawns. So membership is free, the cap goes
 * away, and the only shas that still cost a spawn are the ones NOT on main --
 * the minority, and the ones a red row is about.
 *
 * ABBREVIATED SHAS ARE THE WHOLE COMPLICATION. `closes:` is hand-written at 7-8
 * characters while `rev-list` emits 40, so a plain `Set.has` would miss every
 * hand-written entry and send it down the slow path to be re-answered correctly
 * -- correct, but it would quietly undo the speedup for exactly the rows people
 * write by hand. Bucketing by the first four characters (the shortest sha the
 * resolver will accept) makes a short lookup a scan of a handful of candidates
 * instead of all 3,800.
 */

/** Membership test for "reachable from the base", by full OR abbreviated sha. */
export interface MainCommitSet {
  has(sha: string): boolean
  /** How many commits the base reaches. 0 means the listing failed and every
   *  lookup will miss -- the caller must fall back rather than read a miss as
   *  "not on main". */
  size: number
}

/** The shortest abbreviation `promise-git.ts` will accept, and therefore the
 *  widest bucket key that can never split a legal lookup across two buckets. */
const BUCKET = 4

const EMPTY: MainCommitSet = { has: () => false, size: 0 }

/**
 * Index `git rev-list` output.
 *
 * Exported separately from the spawn so the bucketing is provable without a
 * repo on disk -- same reason the resolver takes its git access as a parameter.
 */
export function indexCommits(shas: readonly string[]): MainCommitSet {
  const full = new Set<string>()
  const buckets = new Map<string, string[]>()

  for (const sha of shas) {
    if (sha.length < BUCKET) continue
    full.add(sha)
    const key = sha.slice(0, BUCKET)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(sha)
    else buckets.set(key, [sha])
  }

  return {
    size: full.size,
    has(sha: string): boolean {
      const lower = sha.toLowerCase()
      if (full.has(lower)) return true
      if (lower.length < BUCKET) return false
      return (buckets.get(lower.slice(0, BUCKET)) ?? []).some(candidate => candidate.startsWith(lower))
    },
  }
}

/** Parse one `git rev-list` stdout blob. Blank-tolerant: an empty repo prints
 *  nothing and must index to an empty set, not to a set containing `''`. */
export function parseRevList(stdout: string): MainCommitSet {
  const lines = stdout
    .split('\n')
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 0)
  return lines.length === 0 ? EMPTY : indexCommits(lines)
}
