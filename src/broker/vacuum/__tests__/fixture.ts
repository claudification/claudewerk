/**
 * Vacuum fixtures. Builds on the archive fixture's store.db rather than
 * re-declaring the transcript schema, and adds the two things the vacuum
 * estimate needs and archiving does not: a `conversations` table (so rows can
 * be ended, live, or orphaned) and the duplicate-index pair that the
 * sessions -> conversations rename left behind on the real database.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeStoreDb } from '../../archive/__tests__/fixture'

export { seedMonths } from '../../archive/__tests__/fixture'

export type ConvStatus = 'active' | 'idle' | 'ended'

export function makeVacuumDb(cacheDir: string): string {
  const path = makeStoreDb(cacheDir)
  const db = new Database(path, { strict: true })
  db.run(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      scope TEXT,
      title TEXT,
      status TEXT NOT NULL,
      created_at INTEGER,
      ended_at INTEGER
    )`)
  // The real pairs: canonical name plus the legacy 'session' duplicate.
  db.run('CREATE INDEX idx_transcript_conversation ON transcript_entries(conversation_id)')
  db.run('CREATE INDEX idx_transcript_session ON transcript_entries(conversation_id)')
  db.run('CREATE INDEX idx_transcript_conversation_seq ON transcript_entries(conversation_id, seq)')
  db.run('CREATE INDEX idx_transcript_session_seq ON transcript_entries(conversation_id, seq)')
  // A genuinely unique index, to prove the detector does not flag it.
  db.run('CREATE INDEX idx_transcript_timestamp ON transcript_entries(timestamp)')
  db.close()
  return path
}

/** Register a conversation for a seeded month. `seedMonths` writes every row of
 *  a month under `conv_<month>`, so a month with no matching row here is
 *  orphaned -- which is exactly how the real orphans look. */
export function addConversation(cacheDir: string, month: string, status: ConvStatus): void {
  const db = new Database(join(cacheDir, 'store.db'), { strict: true })
  try {
    db.run(`INSERT INTO conversations (id, scope, title, status, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)`, [
      `conv_${month}`,
      'claude://default/tmp/fixture',
      `conversation for ${month}`,
      status,
      0,
      status === 'ended' ? 1 : null,
    ])
  } finally {
    db.close()
  }
}

/** A `.last-success.json` the backup gate will accept, plus the archive it
 *  names -- the gate re-hashes the file rather than trusting the sentinel.
 *
 *  Written synchronously on purpose: `Bun.write` returns a promise, and a
 *  fixture that races the test it sets up fails intermittently in exactly the
 *  way nobody wants to debug. */
export function writeBackupSentinel(backupDir: string, opts: { ageMinutes?: number; now?: number } = {}): void {
  const now = opts.now ?? Date.now()
  const epochMs = now - (opts.ageMinutes ?? 5) * 60_000
  const archive = 'backup-fixture.tar.zst'
  const body = 'fixture archive contents'
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(join(backupDir, archive), body)
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(body)
  writeFileSync(
    join(backupDir, '.last-success.json'),
    `${JSON.stringify({
      timestamp: new Date(epochMs).toISOString(),
      epochMs,
      archive,
      sizeBytes: body.length,
      sha256: hasher.digest('hex'),
      durationMs: 1,
      brokerVersion: 'fixture',
    })}\n`,
  )
}
