#!/usr/bin/env bun
/**
 * PROMISE BACKFILL -- give the cards filed before the ledger existed either the
 * commit that delivered them, or an honest amnesty.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  DRY RUN BY DEFAULT. `--write` is the only thing that touches a card.     ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * WHY THIS EXISTS. `closedWithoutCommit` was reporting 349 cards -- 342 of them
 * on this board -- as "filed as finished with no commit behind it". Every one of
 * those was closed before `promise:` was a thing anybody could write, so the
 * table was true and useless: a reader learns within a day to scroll past a red
 * block that big, and then the one card that IS a real finding goes unread.
 *
 * WHY IT IS IDEMPOTENT AND WHY THAT MATTERS. `appendCloses` adds only what is
 * missing and `insertPromiseBlock` no-ops on a card that already has a block, so
 * a second run writes nothing. That is what makes it safe to dry-run, eyeball,
 * run for real, and run again later when more branches have landed.
 *
 * Usage:
 *   bun run scripts/promise-backfill.ts                 # dry run, this repo
 *   bun run scripts/promise-backfill.ts --write         # do it
 *   bun run scripts/promise-backfill.ts --only <cardId> # one card, for a look
 *   bun run scripts/promise-backfill.ts --verbose       # every card, no sampling
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../src/shared/frontmatter'
import { parsePromiseBlock } from '../src/shared/promise-ledger'
import { applyPlan } from './promise-backfill/apply'
import { evidenceFor } from './promise-backfill/evidence'
import { type BackfillCard, planFor } from './promise-backfill/join'
import { type Outcome, renderReport } from './promise-backfill/report'

/**
 * The day `src/shared/promise-ledger.ts` first landed on main (`b227947e`).
 *
 * A card created ON OR AFTER this could have carried a promise, so if it is
 * filed with nothing behind it that is a real finding and it keeps its red row.
 * Overridable, because another board adopting this file has a different date --
 * but never inferred, so `--help` always shows the operator what is being
 * forgiven and from when.
 */
const LEDGER_EPOCH = '2026-08-21'

interface Args {
  repo: string
  board: string
  base: string
  cutoff: string
  write: boolean
  only: string | null
  verbose: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
  }
  const repo = get('--repo', process.cwd())
  return {
    repo,
    board: get('--board', join(repo, '.rclaude/project/cards')),
    base: get('--base', 'main'),
    cutoff: get('--cutoff', LEDGER_EPOCH),
    write: argv.includes('--write'),
    verbose: argv.includes('--verbose'),
    only: argv.indexOf('--only') >= 0 ? get('--only', '') : null,
  }
}

/** Read one card off disk into the shape `planFor` wants. */
function readCard(board: string, file: string): { card: BackfillCard; text: string } {
  const text = readFileSync(join(board, file), 'utf8')
  const { meta } = parseFrontmatter(text)
  return {
    text,
    card: {
      id: file.replace(/\.md$/, ''),
      status: String(meta.status ?? ''),
      created: typeof meta.created === 'string' && meta.created.length > 0 ? meta.created : null,
      // The FLAT parser cannot see a nested block, which is the whole reason
      // `parsePromiseBlock` reads raw text. Asking `meta.promise` here would say
      // "no block" on every card that has one.
      hasPromise: parsePromiseBlock(text) !== null,
    },
  }
}

/**
 * What actually happened, as distinct from what was planned.
 *
 * "RECORDED" has to mean a card moved. A plan that intended to write and then
 * changed no bytes is the idempotent case -- the second run over a card the
 * first run already did -- and reporting those in the RECORDED bucket would
 * make every re-run claim it did the whole job again.
 */
function settle(
  action: 'record' | 'amnesty' | 'skip',
  why: string,
  applied: { changed: boolean; refused: string | null; added: string[] },
): Omit<Outcome, 'id'> {
  if (applied.refused !== null) return { action, why, added: [], refused: applied.refused }
  if (action === 'skip') return { action, why, added: [], refused: null }
  if (!applied.changed) return { action: 'skip', why: `${why} -- already up to date`, added: [], refused: null }
  return { action, why, added: applied.added, refused: null }
}

// One card, end to end. The ONLY place in this file that writes anything.
// Twelve lines; the score is the no-coverage CRAP estimate for a five-branch
// function, which lands exactly on the 30.0 threshold by arithmetic alone.
// fallow-ignore-next-line complexity
function runOne(args: Args, file: string): Outcome {
  const { card, text } = readCard(args.board, file)
  // Cheap gate first: a card that is not filed needs no git at all, and this is
  // the difference between ~200 git invocations and ~1700.
  const filed = card.status === 'done' || card.status === 'archived'
  const evidence = filed ? evidenceFor(args.repo, args.base, card.id, text) : null

  const plan = planFor(card, evidence, args.cutoff)
  const applied = applyPlan(text, plan)
  if (args.write && applied.changed) writeFileSync(join(args.board, file), applied.text)
  return { id: card.id, ...settle(plan.action, plan.why, applied) }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const files = readdirSync(args.board)
    .filter(f => f.endsWith('.md'))
    .filter(f => args.only === null || f === `${args.only}.md`)
    .sort()

  const outcomes = files.map(file => runOne(args, file))
  process.stdout.write(
    renderReport(outcomes, { write: args.write, base: args.base, cutoff: args.cutoff, verbose: args.verbose }),
  )
}

main()
