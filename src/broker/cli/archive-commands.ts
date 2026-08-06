import {
  archiveCoverage,
  exportMonth,
  importMonth,
  monthsToArchive,
  pruneArchivedMonth,
  verifyArchive,
} from '../archive'
import { renderCoverage, renderVerify } from './archive-render'
import type { ParsedArgs } from './parse-args'
import { DEFAULT_ARCHIVE_DIR } from './shared'
import { dispatchSubcommand, positiveIntArg, type SubcommandMap } from './subcommand'

function getArchiveDir(args: ParsedArgs): string {
  return args.archiveDirArg || DEFAULT_ARCHIVE_DIR
}

function requireMonth(args: ParsedArgs, verb: string): string {
  if (!args.monthArg) {
    console.error(`ERROR: provide a month, e.g. broker-cli archive ${verb} 2026-06`)
    process.exit(1)
  }
  return args.monthArg
}

function handleList(args: ParsedArgs): void {
  const archiveDir = getArchiveDir(args)
  const coverage = archiveCoverage(args.cacheDir, archiveDir)
  if (args.jsonFlag) console.log(JSON.stringify(coverage, null, 2))
  else renderCoverage(coverage, archiveDir)
}

async function handleExport(args: ParsedArgs): Promise<void> {
  const level = args.levelArg ? parseInt(args.levelArg, 10) : undefined
  await exportMonth({
    cacheDir: args.cacheDir,
    archiveDir: getArchiveDir(args),
    month: requireMonth(args, 'export'),
    force: args.forceFlag,
    ...(level !== undefined && { level }),
  })
}

async function handleVerify(args: ParsedArgs): Promise<void> {
  const result = await verifyArchive(getArchiveDir(args), requireMonth(args, 'verify'), {
    ...(args.againstDbFlag && { cacheDir: args.cacheDir }),
  })

  if (args.jsonFlag) console.log(JSON.stringify(result, null, 2))
  else renderVerify(result)
  process.exit(result.ok ? 0 : 1)
}

async function handleImport(args: ParsedArgs): Promise<void> {
  await importMonth({
    archiveDir: getArchiveDir(args),
    month: requireMonth(args, 'import'),
    cacheDir: args.cacheDir,
    ...(args.targetDbArg && { targetDb: args.targetDbArg }),
  })
}

/** The irreversible one. Dry run unless --confirm, and even then
 *  pruneArchivedMonth re-verifies against the live database and rolls back on
 *  any row-count drift. */
async function handlePrune(args: ParsedArgs): Promise<void> {
  const result = await pruneArchivedMonth({
    cacheDir: args.cacheDir,
    archiveDir: getArchiveDir(args),
    month: requireMonth(args, 'prune'),
    confirm: args.confirmFlag,
  })
  console.log(`${result.applied ? 'APPLIED' : 'NOT APPLIED'}: ${result.month} -- ${result.reason}`)
  process.exit(result.applied || !args.confirmFlag ? 0 : 1)
}

function handleCandidates(args: ParsedArgs): void {
  const hotDays = positiveIntArg(args.hotDaysArg, 90, '--hot-days')
  const months = monthsToArchive(args.cacheDir, hotDays)
  if (args.jsonFlag) {
    console.log(JSON.stringify({ hotDays, months }, null, 2))
    return
  }
  console.log(
    months.length === 0
      ? `No months fully older than ${hotDays} days`
      : `Months eligible to archive (hot-days=${hotDays}): ${months.join(', ')}`,
  )
}

const SUBCOMMANDS: SubcommandMap = {
  list: handleList,
  export: handleExport,
  verify: handleVerify,
  import: handleImport,
  prune: handlePrune,
  candidates: handleCandidates,
}

export async function handleArchive(args: ParsedArgs): Promise<void> {
  await dispatchSubcommand('archive', SUBCOMMANDS, args)
}
