#!/usr/bin/env bun

import { dirname, resolve } from 'node:path'
/**
 * wall-verify -- does THE WALL actually deliver what was promised?
 *
 * Run it after every epic beat. A board full of `done` cards is a claim; this is
 * the check. It reads the delivery contract in `wall-verify/manifest.ts`, probes
 * the tree for each promised aspect, and shouts about the two failures that
 * matter: a settled card that did not deliver, and a promise whose upstream feed
 * does not exist at all.
 *
 *   bun run verify:wall           human report
 *   bun run verify:wall --json    machine readable, for a hook or the A7 pane
 *
 * Exit: 0 clean . 1 a settled card did not deliver . 2 something CANNOT be built
 */
import { ASPECTS } from './wall-verify/manifest'
import { evaluate } from './wall-verify/probe'
import { exitCode, render } from './wall-verify/report'

const code = (await Bun.$`git rev-parse --show-toplevel`.text()).trim()
// The board is gitignored, so it lives ONLY in the main working tree. From a
// worktree, --git-common-dir points at the main repo's .git; its parent is the
// board's home. Verifying a worktree against its own empty .rclaude/ would
// report every card as "not on the board", which is how this bug announced
// itself on the very first run.
const commonDir = resolve(code, (await Bun.$`git rev-parse --git-common-dir`.text()).trim())
const board = dirname(commonDir)
const results = ASPECTS.map(a => evaluate({ code, board }, a))

/**
 * Unmerged work is not missing work. An epic runs a dozen branches at once, so
 * an aspect can be fully built and still absent from the tree you are standing
 * in. Naming the branch turns "where is it" into "it is right here, unmerged",
 * which is the difference between chasing a ghost and running a merge.
 */
async function unmergedBranches(card: string): Promise<string> {
  // The format string goes through interpolation, not the literal: Bun's shell
  // parser treats a bare `%(refname:short)` as a syntax error on the parens.
  const fmt = '--format=%(refname:short)'
  const list = (await Bun.$`git branch --list ${`*${card}`} ${fmt}`.text()).trim()
  const branches = list.split('\n').filter(b => b && !b.includes('verify-'))
  const ahead = await Promise.all(
    branches.map(async b => {
      const n = (await Bun.$`git rev-list --count main..${b}`.text().catch(() => '0')).trim()
      return { b, n: Number(n) || 0 }
    }),
  )
  const live = ahead.filter(x => x.n > 0)
  return live.map(x => `${x.b} (+${x.n})`).join(', ')
}

for (const r of results) {
  if (r.verdict === 'VERIFIED') continue
  const own = await unmergedBranches(r.aspect.card)
  if (own) r.failures.push(`built but NOT MERGED: ${own}`)

  // A dead feed whose owner is DONE but unmerged is a merge away, not a dead
  // end. Shouting CANNOT DELIVER at work that is finished and sitting on a
  // branch is the fastest way to teach someone to ignore the shouting.
  if (r.verdict !== 'UNDELIVERABLE' || !r.aspect.feedFrom) continue
  const feedBranches = await unmergedBranches(r.aspect.feedFrom)
  if (!feedBranches) continue
  r.verdict = 'BLOCKED'
  r.failures.push(`feed is DONE but unmerged, on ${feedBranches} -- merge it and this clears`)
}

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        codeRoot: code,
        boardRoot: board,
        total: results.length,
        verified: results.filter(r => r.verdict === 'VERIFIED').length,
        pending: results.filter(r => r.verdict === 'PENDING').length,
        missing: results.filter(r => r.verdict === 'MISSING').length,
        undeliverable: results.filter(r => r.verdict === 'UNDELIVERABLE').length,
        aspects: results.map(r => ({
          code: r.aspect.code,
          card: r.aspect.card,
          promise: r.aspect.promise,
          verdict: r.verdict,
          cardStatus: r.cardStatus,
          failures: r.failures,
        })),
      },
      null,
      2,
    ),
  )
} else {
  console.log(render(results))
}

process.exit(exitCode(results))
