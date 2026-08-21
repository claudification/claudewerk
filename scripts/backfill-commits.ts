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
 */

import { hostname, userInfo } from 'node:os'
import { basename } from 'node:path'
import { applyNumstatPass, logArgs, parseNameStatusPass, toIngestPayload } from './backfill-commits-git'
import { type BackfillTally, postCommits, resolveBrokerOrigin } from './backfill-commits-post'

const DEFAULT_AUTHORS = ['j@duplo.org', 'jonas@duplo.org']
const DEFAULT_SINCE = '13 months ago'

interface Options {
  repos: string[]
  since: string
  authors: string[]
  sentinel: string
  broker: string
  concurrency: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Options {
  const repos: string[] = []
  const authors: string[] = []
  let since = DEFAULT_SINCE
  let allAuthors = false
  let sentinel = process.env.CLAUDWERK_SENTINEL_NAME || 'default'
  let broker = process.env.RCLAUDE_BROKER || ''
  let concurrency = 16
  let dryRun = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const next = (): string => argv[++i] ?? ''
    if (arg === '--since') since = next()
    else if (arg === '--author') authors.push(next())
    else if (arg === '--all-authors') allAuthors = true
    else if (arg === '--sentinel') sentinel = next()
    else if (arg === '--broker') broker = next()
    else if (arg === '--concurrency') concurrency = Number(next()) || 16
    else if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`)
    else repos.push(arg)
  }

  return {
    repos,
    since,
    authors: allAuthors ? [] : authors.length > 0 ? authors : DEFAULT_AUTHORS,
    sentinel,
    broker,
    concurrency,
    dryRun,
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
