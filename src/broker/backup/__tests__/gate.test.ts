import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256File } from '../hash'
import { checkBackupGate, readSuccessSentinel, writeSuccessSentinel } from '../sentinel'
import type { BackupSuccessSentinel } from '../types'

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'gate-'))
}

function seedArchive(dir: string, name: string, body: string, epochMs: number): BackupSuccessSentinel {
  const path = join(dir, name)
  writeFileSync(path, body)
  const entry: BackupSuccessSentinel = {
    timestamp: new Date(epochMs).toISOString(),
    epochMs,
    archive: name,
    sizeBytes: body.length,
    sha256: sha256File(path),
    durationMs: 1234,
    brokerVersion: 'abc1234',
  }
  writeSuccessSentinel(dir, entry)
  return entry
}

test('passes for a recent, intact archive', () => {
  const d = makeDir()
  try {
    const now = Date.now()
    seedArchive(d, 'backup-20260807-050000.tar.zst', 'archive bytes', now - 10 * 60_000)
    const verdict = checkBackupGate(d, 90, now)
    expect(verdict.ok).toBe(true)
    expect(verdict.reason).toContain('verified')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('fails when no sentinel exists', () => {
  const d = makeDir()
  try {
    const verdict = checkBackupGate(d, 90)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('has a backup ever succeeded')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('fails when the last backup is too old', () => {
  const d = makeDir()
  try {
    const now = Date.now()
    seedArchive(d, 'backup-20260806-050000.tar.zst', 'stale', now - 8 * 3600_000)
    const verdict = checkBackupGate(d, 90, now)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('max 90m')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

// The dangerous case: a sentinel that greenlights a delete with no rollback
// actually on disk behind it.
test('fails when the sentinel points at a missing archive', () => {
  const d = makeDir()
  try {
    const now = Date.now()
    seedArchive(d, 'backup-20260807-050000.tar.zst', 'body', now - 60_000)
    rmSync(join(d, 'backup-20260807-050000.tar.zst'))
    const verdict = checkBackupGate(d, 90, now)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('gone from')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('fails when the archive no longer matches its recorded checksum', () => {
  const d = makeDir()
  try {
    const now = Date.now()
    seedArchive(d, 'backup-20260807-050000.tar.zst', 'original body', now - 60_000)
    // Truncated / rewritten after the fact -- exactly what a half-finished
    // copy or a bit-rotted disk looks like.
    writeFileSync(join(d, 'backup-20260807-050000.tar.zst'), 'tampered')
    const verdict = checkBackupGate(d, 90, now)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('checksum mismatch')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('fails on a future-dated sentinel rather than trusting it', () => {
  const d = makeDir()
  try {
    const now = Date.now()
    seedArchive(d, 'backup-20260807-050000.tar.zst', 'body', now + 3600_000)
    const verdict = checkBackupGate(d, 90, now)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('clock skew')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('sentinel round-trips through disk', () => {
  const d = makeDir()
  try {
    const entry = seedArchive(d, 'backup-20260807-050000.tar.zst', 'body', 1_754_000_000_000)
    expect(readSuccessSentinel(d)).toEqual(entry)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('a corrupt sentinel file reads as absent, not as a throw', () => {
  const d = makeDir()
  try {
    writeFileSync(join(d, '.last-success.json'), '{ not json')
    expect(readSuccessSentinel(d)).toBeNull()
    expect(checkBackupGate(d, 90).ok).toBe(false)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
