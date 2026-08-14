#!/usr/bin/env bun
/**
 * PROJECT DOCTOR -- check a project board's health and print a remedy for
 * everything it finds.
 *
 *   bun run board:doctor                          # this project
 *   bun run board:doctor --root ~/projects/foo    # another one
 *   bun run board:doctor --all ~/projects -q      # every board under a dir
 *   bun run board:doctor --dry-run                # preview the auto-repairs
 *
 * Checks: unreadable cards, missing/invalid `status:`, missing titles, empty
 * cards, ROTTEN CARD LINKS (a link to an id the board does not have), the
 * views/ symlink farm (dangling, wrong target, wrong lane, DUPLICATES across
 * lanes, real files where links belong, missing links), cards still in legacy
 * lane directories, same-id-in-two-lanes collisions, and stray files the board
 * will never read.
 *
 * It never moves or deletes anything, and nearly every finding just tells you
 * what to run or edit. The two exceptions are a missing `created:` (STAMPED
 * from the filesystem) and a known key in the wrong SHAPE (`tags: a, b` reads
 * as no tags at all until it is written `[a, b]`) -- both unambiguous, both
 * idempotent, and both only able to recover a value that was already on the
 * card. `--dry-run` previews them. Exit 1 on errors, or on warnings too with
 * --strict.
 *
 * What a card's frontmatter may contain is declared in one place,
 * `src/shared/card-schema-keys.ts`, and the registry is OPEN: a key it does not
 * know is preserved verbatim and reported by nobody.
 *
 * The parsing and the report live in `src/shared/project-doctor-cli.ts` (pure,
 * tested); this file is only the shell that talks to the process.
 */

import { runProjectDoctor } from '../src/shared/project-doctor'
import { DOCTOR_USAGE, parseDoctorArgs, runDoctor } from '../src/shared/project-doctor-cli'
import type { RepairMode } from '../src/shared/project-doctor-created'
import { findProjectBoards } from '../src/shared/project-upgrade'

function emit(lines: string[], sink: (line: string) => void): void {
  for (const line of lines) sink(line)
}

function main(): number {
  const parsed = parseDoctorArgs(process.argv.slice(2), process.cwd())
  if (parsed.kind === 'help') {
    console.log(DOCTOR_USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    console.error(`${parsed.message}\n\n${DOCTOR_USAGE}`)
    return 2
  }

  const runOne = (root: string, repair: RepairMode) => runProjectDoctor(root, { repair })
  const { out, err, exitCode } = runDoctor(parsed.args, runOne, findProjectBoards)
  emit(out, console.log)
  emit(err, console.error)
  return exitCode
}

process.exit(main())
