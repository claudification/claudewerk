import type { Database } from 'bun:sqlite'

/**
 * Phase 2 spawn-parent-tracking: add parent_conversation_id +
 * root_conversation_id columns to `conversations`. Idempotent ALTER ADD COLUMN
 * (guarded by table_info check). Both columns default to NULL -- pre-existing
 * rows stay unrooted, which is the desired behaviour (no parent backfill).
 */
export function migrateParentColumns(db: Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info('conversations')").all() as Array<{ name: string }>).map(r => r.name),
  )
  if (!cols.has('parent_conversation_id')) {
    db.run('ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT DEFAULT NULL')
  }
  if (!cols.has('root_conversation_id')) {
    db.run('ALTER TABLE conversations ADD COLUMN root_conversation_id TEXT DEFAULT NULL')
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_conversations_root ON conversations(root_conversation_id)')
}
