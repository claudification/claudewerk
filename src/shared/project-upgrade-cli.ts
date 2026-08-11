/**
 * Argument parsing + report formatting for `bun run board:upgrade`.
 *
 * Both are PURE (no process.exit, no console) so the CLI's own file stays a
 * thin shell and the interesting bits -- which flag does what, and what the
 * operator actually gets told -- are testable.
 */

import type { UpgradeOptions, UpgradeReport } from './project-upgrade'

export const UPGRADE_USAGE = `usage: bun run board:upgrade [--root <path> | --all <dir>] [--dry-run] [--no-views] [--no-backup]

  --root <path>  project root holding .rclaude/project (default: cwd)
  --all <dir>    sweep every immediate subdirectory of <dir> that has a board
  --dry-run, -n  report what would happen, touch nothing
  --no-views     skip rebuilding the views/ symlink farm
  --no-backup    skip the pre-move copy of every lane file

The sentinel sweeps each board it watches automatically, so this is for boards
nothing is watching (CLAUDWERK_BOARD_AUTOUPGRADE=0 disables the automatic one).`

export interface UpgradeArgs {
  root: string
  /** Treat `root` as a PARENT of many project roots, not a project itself. */
  all: boolean
  dryRun: boolean
  views: boolean
  backup: boolean
}

/** Valueless flags, keyed by every spelling that selects them. */
const FLAGS: Record<string, (a: UpgradeArgs) => void> = {
  '--dry-run': a => {
    a.dryRun = true
  },
  '-n': a => {
    a.dryRun = true
  },
  '--no-views': a => {
    a.views = false
  },
  '--no-backup': a => {
    a.backup = false
  },
}

export type ParseResult = { kind: 'run'; args: UpgradeArgs } | { kind: 'help' } | { kind: 'error'; message: string }

/** Flags that take the next argv entry as their value. */
const VALUE_FLAGS: Record<string, (a: UpgradeArgs, v: string) => void> = {
  '--root': (a, v) => {
    a.root = v
  },
  '--all': (a, v) => {
    a.root = v
    a.all = true
  },
}

export function parseUpgradeArgs(argv: string[], cwd: string): ParseResult {
  const args: UpgradeArgs = { root: cwd, all: false, dryRun: false, views: true, backup: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const flag = FLAGS[arg]
    const valueFlag = VALUE_FLAGS[arg]
    if (flag) flag(args)
    else if (valueFlag) valueFlag(args, argv[++i] ?? args.root)
    else if (arg === '--help' || arg === '-h') return { kind: 'help' }
    else return { kind: 'error', message: `unknown argument: ${arg}` }
  }
  return { kind: 'run', args }
}

function collisionLines(r: UpgradeReport): string[] {
  if (r.collisions.length === 0) return []
  return [
    '',
    `COLLISIONS -- the same id in more than one lane (${r.collisions.length}):`,
    ...r.collisions.map(c => `  ${c.slug}: ${c.lanes.join(', ')} -> keeping "${c.lanes[c.lanes.length - 1]}"`),
    '  (kept = furthest along the pipeline; the losers stay where they are, untouched)',
  ]
}

function moveLines(r: UpgradeReport, dryRun: boolean): string[] {
  if (r.legacy.length === 0) return ['already migrated']
  if (dryRun) {
    return [
      '',
      '--dry-run: would move',
      ...r.legacy.map(c => `  ${c.status}/${c.slug}.md -> cards/${c.slug}.md  (status: ${c.status})`),
    ]
  }
  return [
    ...(r.backupDir ? ['', `backed up ${r.backedUp} file(s) to ${r.backupDir}`] : []),
    `moved ${r.moved.length} card(s) into cards/`,
    ...(r.lanesRemoved.length > 0 ? [`removed empty lane dirs: ${r.lanesRemoved.join(', ')}`] : []),
  ]
}

function viewLines(r: UpgradeReport): string[] {
  if (!r.views) return []
  if (!r.views.supported) return ['views: filesystem refused symlinks -- skipped (they are cosmetic)']
  return [`views: +${r.views.created} -${r.views.pruned}`]
}

export interface FormattedReport {
  out: string[]
  err: string[]
  exitCode: number
}

/** Runs one board. Injected so the whole CLI is testable without a filesystem. */
export type BoardRunner = (root: string, opts: UpgradeOptions) => UpgradeReport
/** Resolves `--all <dir>` to the project roots under it. Injected likewise. */
export type BoardFinder = (parent: string) => string[]

/**
 * The whole run: one board, or every board under `--all`. Worst exit code wins,
 * so a sweep that fails on one project still reports failure.
 */
export function runUpgrade(args: UpgradeArgs, run: BoardRunner, find: BoardFinder): FormattedReport {
  const { root, all, ...opts } = args
  const roots = all ? find(root) : [root]
  const result: FormattedReport = {
    out: all ? [`sweeping ${roots.length} board(s) under ${root}`, ''] : [],
    err: [],
    exitCode: 0,
  }
  for (const r of roots) {
    const one = formatUpgradeReport(run(r, opts), opts.dryRun)
    result.out.push(...one.out, ...(all ? [''] : []))
    result.err.push(...one.err)
    result.exitCode = Math.max(result.exitCode, one.exitCode)
  }
  return result
}

/** Everything the operator sees, plus the exit code, derived from the report. */
export function formatUpgradeReport(r: UpgradeReport, dryRun: boolean): FormattedReport {
  if (r.noBoard) return { out: [`no board at ${r.board} -- nothing to do`], err: [], exitCode: 0 }

  const out = [
    `board: ${r.board}`,
    `cards in legacy lane folders: ${r.legacy.length}`,
    ...collisionLines(r),
    ...moveLines(r, dryRun),
    ...viewLines(r),
  ]
  if (r.failures.length === 0) return { out, err: [], exitCode: 0 }
  return {
    out,
    err: [
      '',
      `FAILED to move ${r.failures.length} card(s):`,
      ...r.failures.map(f => `  ${f.from}/${f.slug}.md: ${f.error}`),
    ],
    exitCode: 1,
  }
}
