#!/usr/bin/env bun
/**
 * Drain a project board's legacy status folders into the canonical card store.
 *
 *   .rclaude/project/<status>/<id>.md  ->  .rclaude/project/cards/<id>.md
 *                                          + `status: <status>` frontmatter
 *
 * Run it in ANY project, not just this repo:
 *
 *   bun run board:upgrade --root ~/projects/whatever --dry-run
 *   bun run board:upgrade --root ~/projects/whatever
 *
 * Safe to run repeatedly: on an already-migrated board it just rebuilds the
 * `views/` symlink farm and exits 0.
 *
 * The parsing and the report live in `src/shared/project-upgrade-cli.ts` (pure,
 * tested); this file is only the shell that talks to the process.
 *
 * Why: .claude/docs/plan-board-card-identity.md
 */

import { upgradeProjectBoard } from '../src/shared/project-upgrade'
import { formatUpgradeReport, parseUpgradeArgs, UPGRADE_USAGE } from '../src/shared/project-upgrade-cli'

function emit(lines: string[], sink: (line: string) => void): void {
  for (const line of lines) sink(line)
}

function main(): number {
  const parsed = parseUpgradeArgs(process.argv.slice(2), process.cwd())
  if (parsed.kind === 'help') {
    console.log(UPGRADE_USAGE)
    return 0
  }
  if (parsed.kind === 'error') {
    console.error(`${parsed.message}\n\n${UPGRADE_USAGE}`)
    return 2
  }

  const { root, ...opts } = parsed.args
  const { out, err, exitCode } = formatUpgradeReport(upgradeProjectBoard(root, opts), opts.dryRun)
  emit(out, console.log)
  emit(err, console.error)
  return exitCode
}

process.exit(main())
