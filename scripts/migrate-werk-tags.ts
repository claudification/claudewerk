#!/usr/bin/env bun
/**
 * Rewrite `needs-overseer` -> `needs-werk-master` on a project board's cards.
 *
 * The seat rename (`werk-rename-seats`) moved the tag the blocked channel is
 * keyed on. The cards carrying the old word are DATA, in whichever project
 * board they live in -- a branch cannot reach them, so this is the migration
 * for that half, run once per board:
 *
 *   bun run migrate:werk-tags --root ~/projects/whatever --dry-run
 *   bun run migrate:werk-tags --root ~/projects/whatever
 *
 * Idempotent: a board with no old tags left prints `0 card(s)` and exits 0.
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

const USAGE = `usage: bun run migrate:werk-tags [--root <project>] [--dry-run]

  --root <path>   project root holding .rclaude/project/cards (default: cwd)
  --dry-run       report what would change and write nothing`

function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }
  const dryRun = argv.includes('--dry-run')
  const rootIdx = argv.indexOf('--root')
  if (rootIdx !== -1 && !argv[rootIdx + 1]) {
    console.error(`--root needs a path\n\n${USAGE}`)
    return 2
  }
  const root = rootIdx === -1 ? process.cwd() : (argv[rootIdx + 1] as string)

  // `create: false` -- a project with no board is not an error worth creating
  // a directory over.
  const dir = cardsDir(root, false)
  let files: string[]
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory')
    files = readdirSync(dir).filter(f => f.endsWith('.md'))
  } catch {
    console.error(`no card store at ${dir}`)
    return 2
  }

  const changed: string[] = []
  for (const file of files.sort()) {
    const path = join(dir, file)
    const next = renameNeedsOverseerTag(readFileSync(path, 'utf8'))
    if (next === null) continue
    changed.push(file)
    if (!dryRun) writeFileAtomic(path, next)
  }

  for (const file of changed) console.log(`  ${dryRun ? 'would rewrite' : 'rewrote'} ${file}`)
  console.log(
    `${changed.length} card(s) ${dryRun ? 'would move' : 'moved'} to needs-werk-master (${files.length} scanned)`,
  )
  return 0
}

process.exit(main(process.argv.slice(2)))
