import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256File } from './hash'
import { type BackupSuccessSentinel, SUCCESS_SENTINEL } from './types'

export interface GateVerdict {
  ok: boolean
  reason: string
  sentinel: BackupSuccessSentinel | null
}

function sentinelPath(destDir: string): string {
  return join(destDir, SUCCESS_SENTINEL)
}

export function writeSuccessSentinel(destDir: string, entry: BackupSuccessSentinel): void {
  writeFileSync(sentinelPath(destDir), `${JSON.stringify(entry, null, 2)}\n`)
}

export function readSuccessSentinel(destDir: string): BackupSuccessSentinel | null {
  const p = sentinelPath(destDir)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as BackupSuccessSentinel
  } catch {
    return null
  }
}

/** The maintenance gate.
 *
 *  Nothing destructive runs unless a recent backup exists AND its archive is
 *  still byte-identical to what we recorded. A sentinel pointing at a truncated
 *  or deleted archive is worse than no sentinel -- it would greenlight a delete
 *  with no rollback behind it, so a checksum mismatch fails closed.
 *
 *  Re-hashing is deliberate and costs a full read of the archive. That is a
 *  rounding error next to the operation it is guarding. */
export function checkBackupGate(destDir: string, maxAgeMinutes: number, now = Date.now()): GateVerdict {
  const sentinel = readSuccessSentinel(destDir)
  if (!sentinel) {
    return { ok: false, reason: `no ${SUCCESS_SENTINEL} in ${destDir} -- has a backup ever succeeded?`, sentinel: null }
  }

  const ageMs = now - sentinel.epochMs
  const ageMin = Math.round(ageMs / 60_000)
  if (ageMs > maxAgeMinutes * 60_000) {
    return { ok: false, reason: `last successful backup is ${ageMin}m old (max ${maxAgeMinutes}m)`, sentinel }
  }
  if (ageMs < 0) {
    return {
      ok: false,
      reason: `last successful backup is timestamped ${-ageMin}m in the future -- clock skew?`,
      sentinel,
    }
  }

  const archivePath = join(destDir, sentinel.archive)
  if (!existsSync(archivePath)) {
    return { ok: false, reason: `sentinel names ${sentinel.archive} but it is gone from ${destDir}`, sentinel }
  }

  const actual = sha256File(archivePath)
  if (actual !== sentinel.sha256) {
    return {
      ok: false,
      reason: `${sentinel.archive} checksum mismatch (expected ${sentinel.sha256.slice(0, 12)}..., got ${actual.slice(0, 12)}...)`,
      sentinel,
    }
  }

  return { ok: true, reason: `verified ${sentinel.archive}, ${ageMin}m old`, sentinel }
}
