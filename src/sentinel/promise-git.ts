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

/**
 * Ceiling on how many DISTINCT shas one scan will ask git about.
 *
 * Each sha costs two `git` spawns and the answers are memoised, so a normal
 * board (a handful of promises) never comes near this. It is a guard against a
 * pathological card -- a `closes:` list someone pasted a whole `git log` into --
 * turning one board read into a thousand processes. Over the cap the answer is
 * `null`, i.e. `could not verify`: refusing to check is honest, and inventing
 * `false` for a sha we declined to look at is the accusation this file exists to
 * avoid.
 */
const MAX_RESOLVED_SHAS = 200

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

  return (sha: string): CommitStanding => {
    const cached = seen.get(sha)
    if (cached) return cached

    const standing = resolveOne(cwd, base, sha, seen.size >= MAX_RESOLVED_SHAS)
    seen.set(sha, standing)
    return standing
  }
}

function resolveOne(cwd: string, base: string | null, sha: string, overCap: boolean): CommitStanding {
  if (base === null || overCap || !SHA.test(sha)) return { ...UNKNOWN, sha }
  if (!git(cwd, ['cat-file', '-e', `${sha}^{commit}`]).ok) {
    // git looked and did not find it. THIS is the one place `exists: false` is
    // earned -- the repo answered, and the answer was no.
    return { sha, exists: false, onMain: false }
  }
  return { sha, exists: true, onMain: git(cwd, ['merge-base', '--is-ancestor', sha, base]).ok }
}
