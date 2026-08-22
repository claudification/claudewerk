/**
 * The promise ledger's `CommitResolver`, backed by real git.
 *
 * IT LIVES ON THE SENTINEL because that is the only side allowed to ask. The
 * core module (`src/shared/promise-ledger.ts`) takes the resolver as a parameter
 * precisely so this file can exist over here: `src/broker/` must not run git
 * (CWD IS INFORMATIONAL, `bun run lint:boundary` enforces it) and the browser
 * obviously cannot. The sentinel owns the host filesystem and already runs the
 * git-fabric ladder next door, so one more `git -C` is not a new capability.
 *
 * TWO QUESTIONS, AND THE THIRD ANSWER MATTERS MOST:
 *
 *   exists  -- `cat-file -e <sha>^{commit}`
 *   onMain  -- `merge-base --is-ancestor <sha> <base>`
 *   neither -- `null`, which the core module reads as `could not verify`
 *
 * `null` IS NOT A FAILURE MODE, IT IS THE POINT. Every path that cannot get a
 * straight answer out of git returns nulls rather than guessing `false`, because
 * `false` is an ACCUSATION: `exists: false` renders `names a commit that does not
 * exist` and `onMain: false` renders `commit is NOT on main`, the two loudest
 * verdicts in the ledger. A ledger that cries wolf over a repo that merely had no
 * `main` branch is one nobody reads, and an unread ledger is the state we started
 * in. False open is noise; false accusation is the end of the feature.
 *
 * BASE IS LOCAL `main`, NOT `origin/main`. This deviates from `git-fabric.ts` on
 * purpose. The fabric asks "is this branch integrated with what everyone else
 * can see", so the remote is the right yardstick. A promise asks "did this land",
 * and in this repo LOCAL MAIN IS THE SOURCE OF TRUTH with origin a push-only
 * mirror -- main sits tens of commits unpushed as a matter of routine. Judging
 * against `origin/main` would report every delivered-but-unpushed promise as
 * `commit is NOT on main`, which is exactly the false accusation above, in bulk.
 */

import type { CommitResolver, CommitStanding } from '../shared/promise-ledger'
import { type MainCommitSet, parseRevList } from './promise-main-set'

/**
 * Ceiling on how many distinct shas one scan will SPAWN GIT for.
 *
 * It used to bound every sha, at two spawns each, and that made it a cliff: past
 * the 200th the answer became `could not verify`, this board reached 204, and
 * four delivered cards were accused in the loud table. `promise-main-set.ts` now
 * answers "is it on main" for the whole repo in ONE spawn, so a sha reachable
 * from the base costs nothing and is NEVER capped.
 *
 * What survives is a guard on the SLOW PATH only -- the shas the base does not
 * reach, which is what a red row is about anyway. A pathological card (someone
 * pastes a whole `git log` into `closes:`) still cannot turn one board read into
 * a thousand processes. Over the cap the answer stays `null`: refusing to check
 * is honest, and inventing `false` for a sha we declined to look at is the
 * accusation this file exists to avoid.
 */
const MAX_SPAWNED_SHAS = 200

/** A sha shaped like a sha. Anything else never reaches git: an argument off a
 *  hand-written card must not be able to look like a flag or a revset. */
const SHA = /^[0-9a-f]{4,40}$/i

interface GitRun {
  ok: boolean
  stdout: string
}

/** One `git -C cwd <args>`. Never throws; a failed spawn is `ok: false`, which
 *  every caller below turns into `null` rather than into a `false`. */
function git(cwd: string, args: string[]): GitRun {
  try {
    const proc = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { ok: proc.exitCode === 0, stdout: proc.stdout ? new TextDecoder().decode(proc.stdout).trim() : '' }
  } catch {
    return { ok: false, stdout: '' }
  }
}

/**
 * The ref to judge against: local `main`, then local `master`, then `origin/main`
 * as a last resort for a checkout that only ever tracked the remote. Null when
 * the directory is not a repo or carries none of them -- the whole project then
 * reports `could not verify` and `PromiseLedger.resolverBase` says why.
 */
export function resolvePromiseBase(cwd: string): string | null {
  if (!git(cwd, ['rev-parse', '--is-inside-work-tree']).ok) return null
  for (const ref of ['main', 'master', 'origin/main']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok) return ref
  }
  return null
}

/**
 * `git rev-parse HEAD`, verbatim -- half of the board sweep's short-circuit
 * snapshot (`boardSnapshot`).
 *
 * Lives here rather than in the sweep's own module because `git()` above is
 * already the one place this process spawns git with a `-C` and a never-throws
 * contract, and a second private `git()` next door is how two helpers drift into
 * two behaviours.
 *
 * `''` when the directory is not a repo, and that is a USABLE answer: a snapshot
 * built on an empty HEAD simply never matches the stored one, so the sweep
 * recomputes every run instead of short-circuiting on a repo it cannot read.
 */
export function gitHead(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']).stdout
}

const UNKNOWN: CommitStanding = { sha: '', exists: null, onMain: null }

/**
 * A resolver bound to one repo and one base, memoised for the life of the scan.
 *
 * Memoisation is per-scan and not global on purpose: `delivered` is a claim
 * about main AS IT STANDS, and a cached `onMain: true` outliving the revert that
 * made it false is the one bug that would break the ledger's best property --
 * that a reverted promise re-opens itself with nobody having to remember.
 */
export function createGitResolver(cwd: string, base: string | null): CommitResolver {
  const seen = new Map<string, CommitStanding>()
  let spawned = 0
  // Built on the FIRST question, not at construction: a resolver nobody asks
  // anything (a board with no promises) must not pay for a `rev-list`.
  let reachable: MainCommitSet | null = null

  return (sha: string): CommitStanding => {
    const cached = seen.get(sha)
    if (cached) return cached

    if (reachable === null && base !== null) reachable = parseRevList(git(cwd, ['rev-list', base]).stdout)

    let standing: CommitStanding
    if (base === null || !SHA.test(sha)) {
      standing = { ...UNKNOWN, sha }
    } else if (reachable !== null && reachable.has(sha)) {
      // Reachable from the base, so it BOTH exists and is an ancestor. No spawn,
      // and no cap -- this is the answer 95% of a healthy board wants.
      standing = { sha, exists: true, onMain: true }
    } else {
      standing = resolveOffBase(cwd, base, sha, spawned >= MAX_SPAWNED_SHAS)
      spawned += 1
    }

    seen.set(sha, standing)
    return standing
  }
}

/**
 * The slow path: a sha the base does not reach. Either git has never heard of
 * it, or it exists on a branch that never landed -- and those two render as
 * different red rows, so the distinction is worth a spawn.
 *
 * `onMain: false` is safe to assert here without re-asking: this is only reached
 * when the base's own reachability listing did not contain the sha.
 */
function resolveOffBase(cwd: string, base: string, sha: string, overCap: boolean): CommitStanding {
  if (overCap) return { ...UNKNOWN, sha }
  // git looked and did not find it. THIS is the one place `exists: false` is
  // earned -- the repo answered, and the answer was no.
  if (!git(cwd, ['cat-file', '-e', `${sha}^{commit}`]).ok) return { sha, exists: false, onMain: false }
  // The listing can be empty when `rev-list` itself failed, and a miss then means
  // "we never looked", not "not on main". Re-ask git rather than accuse.
  return { sha, exists: true, onMain: git(cwd, ['merge-base', '--is-ancestor', sha, base]).ok }
}
