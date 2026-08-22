#!/usr/bin/env bun
/**
 * Rewrite `needs-overseer` -> `needs-werk-master` on a project board's cards.
 *
 * The seat rename (`werk-rename-seats`) moved the tag the blocked channel is
 * keyed on. The cards carrying the old word are DATA, in whichever project
 * board they live in -- a branch cannot reach them, so this is the migration
 * for that half, run once per board:
 *
 *   bun run migrate:werk-tags --root ~/projects/whatever              # dry run
 *   bun run migrate:werk-tags --root ~/projects/whatever --apply      # writes
 *
 * Idempotent: a board with no old tags left prints `0 card(s)` and exits 0.
 *
 * THE SAFE FORM IS THE DEFAULT, and that is not politeness. This rewrite is
 * DEPLOY-COUPLED: a broker still running the pre-rename image folds over
 * `needs-overseer`, so migrating a live board before that image is replaced
 * turns every open question into a card nothing selects, with no error anywhere
 * (werk-tag-migration-is-deploy-coupled). A default that writes means the
 * cheapest possible typo -- a forgotten flag -- performs that outage. So writing
 * takes a second, explicit word.
 *
 * `--apply` ALSO REQUIRES `--root`. Defaulting the destructive form to `cwd` is
 * how you migrate whichever board you happened to be standing in; the read-only
 * form keeps the cwd default because guessing wrong there costs a wasted scan.
 *
 * BEFORE AND AFTER ARE BOTH COUNTED, off disk, at run time. The card that
 * ordered this migration carried a dry-run count from a previous day and said
 * out loud not to trust it -- cards move. The after-count is a fresh read of the
 * files just written, so "0 remaining" is an observation rather than an
 * inference from the fact that no write threw.
 *
 * The decision is in `src/shared/werk-tag-rename.ts` (pure, tested); this file
 * is only the shell that talks to the filesystem. It writes ATOMICALLY and only
 * the cards that actually change -- an mtime bump on every card is what makes
 * the nightly board sweep think the whole board moved.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../src/shared/atomic-write'
import { cardsDir } from '../src/shared/project-paths'
import { renameNeedsOverseerTag } from '../src/shared/werk-tag-rename'

const USAGE = `usage: bun run migrate:werk-tags [--root <project>] [--apply]

  --root <path>   project root holding .rclaude/project/cards (default: cwd;
                  REQUIRED with --apply)
  --apply         actually write. Without it this is a dry run and nothing
                  changes -- see the header: this migration is deploy-coupled.
  --dry-run       ask for the default explicitly. Cannot be combined with --apply.`

/** The cards under `dir` that still carry the old tag, with their new text.
 *  ONE pass and one predicate for both the before-count and the write, so the
 *  number reported can never be a different question from the work done. */
function pending(dir: string, files: readonly string[]): Array<{ file: string; next: string }> {
  const out: Array<{ file: string; next: string }> = []
  for (const file of files) {
    const next = renameNeedsOverseerTag(readFileSync(join(dir, file), 'utf8'))
    if (next !== null) out.push({ file, next })
  }
  return out
}

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const apply = argv.includes('--apply')
  if (apply && argv.includes('--dry-run')) {
    console.error(`--apply and --dry-run say opposite things; pick one\n\n${USAGE}`)
    return 2
  }
  const rootIdx = argv.indexOf('--root')
  if (rootIdx !== -1 && !argv[rootIdx + 1]) {
    console.error(`--root needs a path\n\n${USAGE}`)
    return 2
  }
  if (apply && rootIdx === -1) {
    console.error(`--apply must name its board: pass --root <project>\n\n${USAGE}`)
    return 2
  }
  const root = rootIdx === -1 ? process.cwd() : (argv[rootIdx + 1] as string)

  // `create: false` -- a project with no board is not an error worth creating
  // a directory over.
  const dir = cardsDir(root, false)
  let files: string[]
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory')
    files = readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort()
  } catch {
    console.error(`no card store at ${dir}`)
    return 2
  }

  const before = pending(dir, files)
  for (const { file } of before) console.log(`  ${apply ? 'rewriting' : 'would rewrite'} ${file}`)
  console.log(`before: ${before.length} card(s) carrying \`needs-overseer\` (${files.length} scanned)`)

  if (!apply) {
    console.log(`dry run -- nothing written. Re-run with --root ${root} --apply once the code half is DEPLOYED.`)
    return 0
  }

  for (const { file, next } of before) writeFileAtomic(join(dir, file), next)

  // Re-read from disk rather than asserting `0`: the point of an after-count is
  // to observe what the board now says, and a card another writer touched
  // mid-run is exactly what a computed zero would hide.
  const after = pending(dir, files)
  console.log(`after:  ${after.length} card(s) carrying \`needs-overseer\``)
  if (after.length > 0) {
    console.error(`still carrying the old tag: ${after.map(p => p.file).join(', ')}`)
    return 1
  }
  console.log(`${before.length} card(s) moved to needs-werk-master`)
  return 0
}

process.exit(main(process.argv.slice(2)))
