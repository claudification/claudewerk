import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkBackupGate, createBackup, listBackups, pruneBackups, restoreBackup } from '../backup'
import type { ParsedArgs } from './parse-args'
import { DEFAULT_BACKUP_DIR } from './shared'
import { dispatchSubcommand, positiveIntArg, type SubcommandMap } from './subcommand'

function getDestDir(args: ParsedArgs): string {
  return args.destArg || DEFAULT_BACKUP_DIR
}

function retention(args: ParsedArgs): { retainHours: number; retainDays: number } {
  return {
    retainHours: positiveIntArg(args.retainHoursArg, 24, '--retain-hours'),
    retainDays: positiveIntArg(args.retainDaysArg, 7, '--retain-days'),
  }
}

async function handleCreate(args: ParsedArgs): Promise<void> {
  await createBackup({
    cacheDir: args.cacheDir,
    destDir: getDestDir(args),
    includeBlobs: args.includeBlobs,
    ...retention(args),
    ...(args.compressorArg && { compressor: args.compressorArg }),
  })
}

function handleList(args: ParsedArgs): void {
  const destDir = getDestDir(args)
  const backups = listBackups(destDir)

  if (backups.length === 0) {
    console.log(`No backups found in ${destDir}`)
    return
  }

  const total = backups.reduce((s, b) => s + b.size, 0)
  console.log(`\n  Backups in ${destDir} (${backups.length}, ${(total / 1024 / 1024 / 1024).toFixed(2)} GB):\n`)
  const pad = (s: string, n: number) => s.padEnd(n)
  console.log(`  ${pad('FILENAME', 38)} ${pad('SIZE', 12)} TIMESTAMP`)
  console.log(`  ${'-'.repeat(38)} ${'-'.repeat(12)} ${'-'.repeat(20)}`)

  for (const b of backups) {
    const sizeMB = `${(b.size / 1024 / 1024).toFixed(1)} MB`
    const ts = b.timestamp.toISOString().replace('T', ' ').slice(0, 19)
    console.log(`  ${pad(b.filename, 38)} ${pad(sizeMB, 12)} ${ts}`)
  }
  console.log()
}

/** Retention without taking a new backup. Previously the only way to reclaim
 *  space was to create another 1.5 GB archive first -- the opposite of what you
 *  want when the disk is the thing that is full. */
function handlePrune(args: ParsedArgs): void {
  const destDir = getDestDir(args)
  const { retainHours, retainDays } = retention(args)
  const result = pruneBackups(destDir, retainHours, retainDays, { dryRun: args.dryRun })
  if (result.deleted.length === 0) console.log(`Nothing to prune in ${destDir} (${result.kept.length} kept)`)
}

function handleGate(args: ParsedArgs): void {
  const verdict = checkBackupGate(getDestDir(args), positiveIntArg(args.maxBackupAgeArg, 90, '--max-backup-age'))
  console.log(args.jsonFlag ? JSON.stringify(verdict, null, 2) : `${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.reason}`)
  process.exit(verdict.ok ? 0 : 1)
}

async function handleRestore(args: ParsedArgs): Promise<void> {
  if (!args.backupArchive) {
    console.error(
      'ERROR: provide archive path, e.g. broker-cli backup restore /data/backups/backup-20260506-120000.tar.zst',
    )
    process.exit(1)
  }

  const archivePath = resolve(args.backupArchive)
  if (!existsSync(archivePath)) {
    console.error(`ERROR: archive not found: ${archivePath}`)
    process.exit(1)
  }

  await restoreBackup(archivePath, args.cacheDir)
}

const SUBCOMMANDS: SubcommandMap = {
  create: handleCreate,
  list: handleList,
  prune: handlePrune,
  gate: handleGate,
  restore: handleRestore,
}

export async function handleBackup(args: ParsedArgs): Promise<void> {
  await dispatchSubcommand('backup', SUBCOMMANDS, args)
}
