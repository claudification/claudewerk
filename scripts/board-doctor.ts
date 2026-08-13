#!/usr/bin/env bun
/**
 * PROJECT DOCTOR -- check a project board's health and print a remedy for
 * everything it finds.
 *
 *   bun run board:doctor                          # this project
 *   bun run board:doctor --root ~/projects/foo    # another one
 *   bun run board:doctor --all ~/projects -q      # every board under a dir
 *
 * Checks: unreadable cards, missing/invalid `status:`, missing titles, empty
 * cards, ROTTEN CARD LINKS (a link to an id the board does not have), the
 * views/ symlink farm (dangling, wrong target, wrong lane, DUPLICATES across
 * lanes, real files where links belong, missing links), cards still in legacy
 * lane directories, same-id-in-two-lanes collisions, and stray files the board
 * will never read.
 *
 * READ ONLY. It never writes, moves or deletes -- every finding tells you what
 * to run or edit instead. Exit 1 on errors, or on warnings too with --strict.
 *
 * The parsing and the report live in `src/shared/project-doctor-cli.ts` (pure,
 * tested); this file is only the shell that talks to the process.
 */

import { runProjectDoctor } from '../src/shared/project-doctor'
import { DOCTOR_USAGE, parseDoctorArgs, runDoctor } from '../src/shared/project-doctor-cli'
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

  const { out, err, exitCode } = runDoctor(parsed.args, runProjectDoctor, findProjectBoards)
  emit(out, console.log)
  emit(err, console.error)
  return exitCode
}

process.exit(main())
