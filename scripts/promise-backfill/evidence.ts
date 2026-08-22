/**
 * WHERE THE EVIDENCE COMES FROM -- the only file in the backfill that talks to git.
 *
 * Kept apart from `join.ts` so the rules stay provable without a repo, and kept
 * to READ-ONLY plumbing so there is nothing here that can damage history.
 *
 * Every query is scoped to `main` (or whatever `--base` says). A commit that is
 * not an ancestor of main has NOT delivered anything -- writing it would
 * manufacture a `not-on-main` row out of a script's guess, which is a false
 * accusation, and this ledger's own doc ranks that as worse than a false open.
 */

import { spawnSync } from 'node:child_process'
import type { ClosingCommit } from '../../src/shared/promise-ledger'
import { type Evidence, isSearchableInProse } from './join'

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return ''
  return r.stdout
}

/** `<sha> <subject>` lines -> commits. Bad lines are dropped, never guessed at. */
function parseCommits(out: string): ClosingCommit[] {
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const sp = line.indexOf(' ')
      return sp < 0 ? { sha: line } : { sha: line.slice(0, sp), subject: line.slice(sp + 1) }
    })
    .filter(c => /^[0-9a-f]{40}$/.test(c.sha))
}

/**
 * The merge commit that landed this card's branch on main. THE ONE FACT.
 *
 * This is the same association the engine makes at settle time
 * (`commit-ledger/branch.ts` ranks `merge` above the branch's own commits,
 * because a merge commit on the trunk is on main by construction), applied
 * retroactively to a run that finished before the engine existed.
 *
 * `--fixed-strings` on a pattern ending in the card id: a card id contains `-`
 * and `.` and would otherwise be a regex. The branch shape is
 * `worktree-epic/<epic>/<id>` or `worktree-<id>`, and BOTH end in `/<id>'` or
 * `-<id>'` -- the trailing quote is what stops `werk-run` matching
 * `werk-run-caps`, which would file one card's merge against another's promise.
 */
export function branchMerge(repo: string, base: string, id: string): ClosingCommit[] {
  const out = git(repo, [
    'log',
    base,
    '--format=%H %s',
    '--fixed-strings',
    `--grep=Merge branch 'worktree-epic/`,
    '--all-match',
    '--fixed-strings',
    `--grep=/${id}'`,
  ])
  const epic = parseCommits(out)
  if (epic.length > 0) return epic
  return parseCommits(
    git(repo, ['log', base, '--format=%H %s', '--fixed-strings', `--grep=Merge branch 'worktree-${id}'`]),
  )
}

/**
 * Commits on main whose MESSAGE names the card id. Inference, and marked so.
 *
 * Weaker than a merge commit in a way worth being precise about: a commit that
 * mentions a card might be implementing it, referencing it, or explaining why it
 * did NOT do it. The sha is real and it is on main -- that part is checked --
 * but the association is a script reading prose, which is exactly what
 * `inferred: true` exists to say out loud.
 *
 * Capped at 12, oldest first, matching the engine's own cap on branch commits.
 */
export function messageMentions(repo: string, base: string, id: string): ClosingCommit[] {
  if (!isSearchableInProse(id)) return []
  const out = git(repo, [
    'log',
    base,
    '--format=%H%x1f%s%x1f%b%x1e',
    '--fixed-strings',
    `--grep=${id}`,
    '--reverse',
    '--max-count=12',
  ])
  return (
    out
      .split('\x1e')
      .map(rec => rec.replace(/^\n/, ''))
      .filter(rec => rec.trim().length > 0)
      .map(rec => {
        const [sha, subject, body] = rec.split('\x1f')
        return { sha, subject: subject ?? '', body: body ?? '' }
      })
      .filter(c => /^[0-9a-f]{40}$/.test(c.sha))
      // A merge commit for the card's own branch would already have been taken as
      // a FACT by `branchMerge`; if we are here it did not match, so anything
      // shaped like a worktree merge is a mention of some OTHER card's branch.
      .filter(c => !c.subject.startsWith('Merge branch '))
      // PREFIX COLLISION. `epic-engine-baton-window` is a prefix of
      // `epic-engine-baton-window-relitigates-settles`, and the longer card's
      // merge commit therefore "mentions" the shorter one. Filing one card's
      // commit against another card's promise is the precise failure the engine's
      // own LIKE-escaping note exists to prevent; this is the same hazard reached
      // through prose instead of through SQL.
      .filter(c => !new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-/\\w]`).test(`${c.subject}\n${c.body}`))
      .map(c => ({ sha: c.sha, subject: c.subject }))
  )
}

/** A `## BUILT` / `## SHIPPED` / `## LANDED` heading, however it is decorated. */
const DELIVERY_HEADING = /^#{1,6}\s.*\b(BUILT|SHIPPED|LANDED)\b/i
const SHA_TOKEN = /\b[0-9a-f]{7,40}\b/g

/**
 * Shas written ON a delivery HEADING LINE in the card's own body.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  THE HEADING LINE ONLY. NOT THE SECTION UNDER IT.                        ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * This started as a sweep of the whole BUILT section and had to be cut back,
 * on evidence. `wall-copy-affordance`'s section recounts an integration -- "what
 * arrived: wall-pane-order-and-sotu-scope (0cb0232f), epic-werk-worker-base-
 * lacks-deps (10168ae1), gate-cmdrunner-blocks-the-mcp-host (7854b49a)" -- and
 * the sweep filed all SEVEN of those against that one card. Three of them belong
 * to other cards that had already earned their own row.
 *
 * The heading line does not wander. It is where a card states its delivery
 * tersely, and this repo writes it exactly that way:
 *
 *     ## BUILT -- O2, as decided. `2ba978d0`
 *     ## WHAT SHIPPED (werk-worker, 4869d5ac + 5ec7e6d4 + 4f1cba28)
 *     ## BUILT (branch `worktree-epic/...`, commit `aada6613`)
 *
 * A token that merely LOOKS like a sha (a date, a hex-ish word) survives this
 * function and is then thrown away by `resolveOnBase`, which asks git. Shape is
 * never taken as proof of existence.
 */
export function deliveryHeadingShas(text: string): string[] {
  const found = text
    .split(/\r?\n/)
    .filter(line => DELIVERY_HEADING.test(line))
    .flatMap(line => line.match(SHA_TOKEN) ?? [])
  return [...new Set(found)]
}

/** Full 40-char sha for a revision that is an ANCESTOR OF BASE, else null. */
export function resolveOnBase(repo: string, base: string, sha: string): ClosingCommit | null {
  const full = git(repo, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).trim()
  if (!/^[0-9a-f]{40}$/.test(full)) return null
  const merged = spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', full, base], { encoding: 'utf8' })
  if (merged.status !== 0) return null
  const subject = git(repo, ['log', '-1', '--format=%s', full]).trim()
  return subject.length > 0 ? { sha: full, subject } : { sha: full }
}

/**
 * The best evidence available for one card, strongest first, first hit wins.
 *
 * Stopping at the first hit is deliberate: piling a weak association on top of a
 * strong one does not make the row truer, it makes `closes:` longer and drags
 * the verdict down to the weakest sha in the list (`verdictFor` takes the worst
 * honest answer). A card with a known merge commit deserves that one line.
 */
export function evidenceFor(repo: string, base: string, id: string, text: string): Evidence | null {
  const merge = branchMerge(repo, base, id)
  if (merge.length > 0) return { kind: 'branch-merge', commits: merge }

  // `messageMentions` gates itself on the id being specific enough to search
  // for. `builtSectionShas` below needs no such gate -- it never searches for
  // the id, it reads shas out of the card's own delivery claim, which is
  // equally trustworthy whether the card is called `bug` or not.
  const mentions = messageMentions(repo, base, id)
  if (mentions.length > 0) return { kind: 'commit-message', commits: mentions }

  const built = deliveryHeadingShas(text)
    .map(sha => resolveOnBase(repo, base, sha))
    .filter((c): c is ClosingCommit => c !== null)
  if (built.length > 0) return { kind: 'built-section', commits: built }

  return null
}
