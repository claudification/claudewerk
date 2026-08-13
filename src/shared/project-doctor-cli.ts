/**
 * Argument parsing + report formatting for `bun run board:doctor`.
 *
 * Both are PURE (no process.exit, no console, no filesystem) so the CLI's own
 * file stays a thin shell -- same split as project-upgrade-cli.ts.
 */

import { countBySeverity, type DoctorFinding, type DoctorReport, type DoctorSeverity } from './project-doctor-types'

export const DOCTOR_USAGE = `usage: bun run board:doctor [--root <path> | --all <dir>] [--quiet] [--verbose] [--strict]

  --root <path>   project root holding .rclaude/project (default: cwd)
  --all <dir>     check every immediate subdirectory of <dir> that has a board
  --quiet, -q     errors and warnings only (drop the info findings)
  --verbose, -v   list every finding instead of collapsing big groups
  --strict        exit non-zero on warnings too, not just errors

Reports what is wrong with a board and what to do about each one. It NEVER
writes: every remedy is a command you run or a line you edit yourself.`

export interface DoctorArgs {
  root: string
  /** Treat `root` as a PARENT of many project roots, not a project itself. */
  all: boolean
  quiet: boolean
  verbose: boolean
  strict: boolean
}

export type ParseResult = { kind: 'run'; args: DoctorArgs } | { kind: 'help' } | { kind: 'error'; message: string }

/**
 * ONE entry per argument (STRATEGY MAPS OVER CHAINS). `next()` consumes the
 * following argv entry, so a value flag and a bare flag are the same shape;
 * returning a ParseResult ends parsing early (that is what `--help` does).
 */
type ArgHandler = (a: DoctorArgs, next: () => string) => ParseResult | void

const ARGS: Record<string, ArgHandler> = {
  '--quiet': a => {
    a.quiet = true
  },
  '-q': a => {
    a.quiet = true
  },
  '--verbose': a => {
    a.verbose = true
  },
  '-v': a => {
    a.verbose = true
  },
  '--strict': a => {
    a.strict = true
  },
  '--root': (a, next) => {
    a.root = next()
  },
  '--all': (a, next) => {
    a.root = next()
    a.all = true
  },
  '--help': () => ({ kind: 'help' }),
  '-h': () => ({ kind: 'help' }),
}

export function parseDoctorArgs(argv: string[], cwd: string): ParseResult {
  const args: DoctorArgs = { root: cwd, all: false, quiet: false, verbose: false, strict: false }
  for (let i = 0; i < argv.length; i++) {
    const handler = ARGS[argv[i]]
    if (!handler) return { kind: 'error', message: `unknown argument: ${argv[i]}` }
    const early = handler(args, () => argv[++i] ?? args.root)
    if (early) return early
  }
  return { kind: 'run', args }
}

const MARK: Record<DoctorSeverity, string> = { error: 'ERROR', warning: 'WARN ', info: 'INFO ' }
/** Above this many findings of one check, collapse them -- 43 identical lines
 *  is not a report, it is a wall, and the wall is what stops people reading. */
const COLLAPSE_AT = 5
const SAMPLE = 3

/** One finding, three lines: what, what is wrong, what to do. */
function findingLines(f: DoctorFinding): string[] {
  return [`  ${MARK[f.severity]} [${f.check}] ${f.subject}`, `        ${f.problem}`, `        -> ${f.remedy}`]
}

/** Many findings of ONE check, as a single entry naming a few of the subjects. */
function groupLines(check: string, group: DoctorFinding[]): string[] {
  const [first] = group
  const sample = group.slice(0, SAMPLE).map(f => f.subject)
  const rest = group.length - sample.length
  return [
    `  ${MARK[first.severity]} [${check}] ${group.length} findings`,
    `        ${first.problem}`,
    `        -> ${first.remedy}`,
    `        ${sample.join(', ')}${rest > 0 ? `, +${rest} more (-v to list)` : ''}`,
  ]
}

/** Group by check, preserving the order findings already came in (errors first). */
function renderFindings(findings: DoctorFinding[], verbose: boolean): string[] {
  const groups = new Map<string, DoctorFinding[]>()
  for (const f of findings) groups.set(f.check, [...(groups.get(f.check) ?? []), f])
  return [...groups].flatMap(([check, group]) =>
    verbose || group.length <= COLLAPSE_AT ? group.flatMap(findingLines) : groupLines(check, group),
  )
}

export interface FormattedReport {
  out: string[]
  err: string[]
  exitCode: number
}

export function formatDoctorReport(
  r: DoctorReport,
  args: Pick<DoctorArgs, 'quiet' | 'strict' | 'verbose'>,
): FormattedReport {
  if (r.noBoard) return { out: [`no board at ${r.board} -- nothing to check`], err: [], exitCode: 0 }

  const shown = args.quiet ? r.findings.filter(f => f.severity !== 'info') : r.findings
  const counts = countBySeverity(r.findings)
  const header = [
    `board: ${r.board}`,
    `cards: ${r.cards}   errors: ${counts.error}   warnings: ${counts.warning}   info: ${counts.info}`,
  ]

  if (shown.length === 0) {
    const clean = counts.error + counts.warning + counts.info === 0
    return { out: [...header, '', clean ? 'clean bill of health' : 'nothing above info level'], err: [], exitCode: 0 }
  }

  const out = [...header, '', ...renderFindings(shown, args.verbose)]
  const failed = counts.error > 0 || (args.strict && counts.warning > 0)
  return { out, err: [], exitCode: failed ? 1 : 0 }
}

/** Runs one board. Injected so the whole CLI is testable without a filesystem. */
export type DoctorRunner = (root: string) => DoctorReport
/** Resolves `--all <dir>` to the project roots under it. Injected likewise. */
export type BoardFinder = (parent: string) => string[]

/** The whole run: one board, or every board under `--all`. Worst exit code wins. */
export function runDoctor(args: DoctorArgs, run: DoctorRunner, find: BoardFinder): FormattedReport {
  const roots = args.all ? find(args.root) : [args.root]
  const result: FormattedReport = {
    out: args.all ? [`checking ${roots.length} board(s) under ${args.root}`, ''] : [],
    err: [],
    exitCode: 0,
  }
  for (const root of roots) {
    const one = formatDoctorReport(run(root), args)
    result.out.push(...one.out, ...(args.all ? [''] : []))
    result.err.push(...one.err)
    result.exitCode = Math.max(result.exitCode, one.exitCode)
  }
  return result
}
