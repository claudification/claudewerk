#!/usr/bin/env bun
/**
 * COMMIT BACKFILL -- walk `git log` for named repos and POST what the ledger is
 * missing to `/api/commits`.
 *
 * The ledger only holds commits made since its post-commit hook was installed.
 * Everything before that is in git and nowhere else, so the ACTIVITY grid's
 * `commits` metric -- the one metric that can actually fill a year -- shows a
 * fortnight. This closes that.
 *
 * IT RUNS ON THE HOST, NOT IN THE BROKER. The broker container bind-mounts its
 * cache and nothing else; it cannot see `~/projects`. So the walk happens here
 * and crosses the seam as the same REST ingest the hook already uses.
 *
 * SAFE TO RE-RUN. The insert is `ON CONFLICT(hash, repo_uri) DO NOTHING`, so a
 * commit the hook already recorded -- with its real conversation attribution --
 * is never overwritten by the unattributed backfill row. Re-running after more
 * history accumulates costs one duplicate check per commit and changes nothing
 * else.
 *
 * AUTHOR-FILTERED BY DEFAULT, and that is not a nicety. Several of these repos
 * are forks with upstream history: `Gmail-MCP-Server` is 94 third-party commits
 * out of 99. Backfilling those unfiltered would paint other people's work onto
 * a grid that answers "how much of my days did we fill". Pass `--all-authors`
 * to include everyone, deliberately.
 *
 * Usage:
 *   bun run scripts/backfill-commits.ts [flags] <repo-path>...
 *
 *   --since <date>      oldest commit to consider        (default: 13 months ago)
 *   --author <email>    repeatable; default j@duplo.org + jonas@duplo.org
 *   --all-authors       do not filter by author
 *   --sentinel <name>   sentinel segment of the URI      (default: $CLAUDWERK_SENTINEL_NAME or "default")
 *   --broker <url>      broker origin                    (default: $RCLAUDE_BROKER)
 *   --concurrency <n>   in-flight POSTs                  (default: 16)
 *   --dry-run           read + report, POST nothing
 *
 * CRAP RULING for the two suppressions below: both are flagged on CRAP only, on
 * an ESTIMATED coverage tier, and both sit at or under the cognitive threshold.
 * What fallow is pricing is that a `scripts/` file has no coverage map -- not
 * that a CLI entry point branches badly. Splitting the flag table or the repo
 * loop further would relocate those decisions rather than remove them.
 */

import { hostname, userInfo } from 'node:os'
import { basename } from 'node:path'
import { applyNumstatPass, logArgs, parseNameStatusPass, toIngestPayload } from './backfill-commits-git'
import { type BackfillTally, postCommits, resolveBrokerOrigin } from './backfill-commits-post'

const DEFAULT_AUTHORS = ['j@duplo.org', 'jonas@duplo.org']
const DEFAULT_SINCE = '13 months ago'
const DEFAULT_CONCURRENCY = 16

interface Options {
  repos: string[]
  since: string
  authors: string[]
  sentinel: string
  broker: string
  concurrency: number
  dryRun: boolean
}

/** Everything the flags can set, before defaults are resolved. */
interface Draft {
  repos: string[]
  authors: string[]
  since: string
  allAuthors: boolean
  sentinel: string
  broker: string
  concurrency: number
  dryRun: boolean
}

/**
 * One handler per flag, keyed by the flag itself -- a `Record` rather than the
 * else-if ladder this started as (STRATEGY MAPS OVER CHAINS). `value` is the
 * next argv entry, already consumed by the caller for the flags that take one;
 * membership in `TAKES_VALUE` is what decides that, so the two never disagree.
 */
const FLAGS: Record<string, (draft: Draft, value: string) => void> = {
  '--since': (d, v) => {
    d.since = v
  },
  '--author': (d, v) => d.authors.push(v),
  '--all-authors': d => {
    d.allAuthors = true
  },
  '--sentinel': (d, v) => {
    d.sentinel = v
  },
  '--broker': (d, v) => {
    d.broker = v
  },
  '--concurrency': (d, v) => {
    d.concurrency = Number(v) || DEFAULT_CONCURRENCY
  },
  '--dry-run': d => {
    d.dryRun = true
  },
}

const TAKES_VALUE = new Set(['--since', '--author', '--sentinel', '--broker', '--concurrency'])

// See CRAP RULING in the header.
// fallow-ignore-next-line complexity
function parseArgs(argv: string[]): Options {
  const draft: Draft = {
    repos: [],
    authors: [],
    since: DEFAULT_SINCE,
    allAuthors: false,
    sentinel: process.env.CLAUDWERK_SENTINEL_NAME || 'default',
    broker: process.env.RCLAUDE_BROKER || '',
    concurrency: DEFAULT_CONCURRENCY,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const handler = FLAGS[arg]
    if (handler) {
      handler(draft, TAKES_VALUE.has(arg) ? (argv[++i] ?? '') : '')
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag ${arg}`)
    } else {
      draft.repos.push(arg)
    }
  }

  return {
    ...draft,
    // `--all-authors` beats an explicit `--author`: asking for everyone and then
    // filtering to one would be a contradiction, and the wider read is the safer
    // way to resolve it -- it shows MORE, it does not silently hide a repo.
    authors: draft.allAuthors ? [] : draft.authors.length > 0 ? draft.authors : DEFAULT_AUTHORS,
  }
}

async function git(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

/** The repo's MAIN root, not a worktree's. A worktree's `--show-toplevel` is its
 *  own directory while the ledger keys every commit on the shared repo, so using
 *  the toplevel would file the same history under two URIs. */
async function repoRootOf(repo: string): Promise<string | null> {
  const common = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  if (common) return common.replace(/\/\.git$/, '')
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim()
  return top || null
}

async function readRepo(repo: string, opts: Options) {
  const repoRoot = await repoRootOf(repo)
  if (!repoRoot) return null

  const [nameStatus, numstat] = await Promise.all([
    git(repo, logArgs(opts.since, opts.authors, false)),
    git(repo, logArgs(opts.since, opts.authors, true)),
  ])
  const commits = parseNameStatusPass(nameStatus)
  applyNumstatPass(numstat, commits)

  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  const ctx = {
    sentinel: opts.sentinel,
    repoRoot,
    repoName: basename(repoRoot),
    branch,
    host: hostname(),
    osUser: userInfo().username,
  }
  return { ctx, payloads: [...commits.values()].map(c => toIngestPayload(c, ctx)) }
}

function report(label: string, tally: BackfillTally): void {
  console.log(
    `  ${label}: ${tally.inserted} inserted, ${tally.duplicate} already known` +
      (tally.failed > 0 ? `, ${tally.failed} FAILED` : ''),
  )
}

// See CRAP RULING in the header.
// fallow-ignore-next-line complexity
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.repos.length === 0) {
    console.error('backfill-commits: no repos given. See the header for usage.')
    process.exit(2)
  }

  const origin = opts.dryRun ? '' : resolveBrokerOrigin(opts.broker)
  const secret = process.env.RCLAUDE_SECRET ?? ''
  if (!opts.dryRun && !secret) {
    console.error('backfill-commits: RCLAUDE_SECRET is not set. Source ~/.secrets first.')
    process.exit(2)
  }

  console.log(
    `backfill-commits: ${opts.repos.length} repos, since "${opts.since}", ` +
      `authors=${opts.authors.length > 0 ? opts.authors.join(',') : 'ALL'}` +
      `${opts.dryRun ? ' [DRY RUN]' : ` -> ${origin}`}`,
  )

  const total: BackfillTally = { inserted: 0, duplicate: 0, failed: 0 }
  for (const repo of opts.repos) {
    const read = await readRepo(repo, opts)
    if (!read) {
      console.log(`  ${repo}: not a git repo, skipped`)
      continue
    }
    const label = `${read.ctx.repoName} (${read.payloads.length} commits)`
    if (opts.dryRun) {
      console.log(`  ${label}: would POST to ${read.ctx.repoRoot}`)
      continue
    }
    const tally = await postCommits(read.payloads, { origin, secret, concurrency: opts.concurrency })
    report(label, tally)
    total.inserted += tally.inserted
    total.duplicate += tally.duplicate
    total.failed += tally.failed
  }

  if (!opts.dryRun) report('TOTAL', total)
  // A failed POST is not a warning. The whole point of the run is that the row
  // lands, and a silent partial backfill reads as a complete one forever after.
  if (total.failed > 0) process.exit(1)
}

await main()
