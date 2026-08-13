import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import type { StoreConfig, StoreDriver } from '../types'
import { createSqliteAddressBookStore } from './address-book'
import { createSqliteConversationStore } from './conversations'
import { createSqliteCostStore } from './costs'
import { createSqliteEventStore } from './events'
import { createSqliteKVStore } from './kv'
import { createSqliteMessageStore } from './messages'
import { migrateMessages } from './migrate-messages'
import { migrateSessionColumns } from './migrate-session-columns'
import { createSqliteScheduledTaskStore } from './scheduled-tasks'
import { createSchema } from './schema'
import { createSqliteScopeLinkStore } from './scope-links'
import { createSqliteShareStore } from './shares'
import { queryStatsIntervalMs, slowQueryThresholdMs, startQueryStatsSummary } from './slow-query-config'
import { instrumentDatabase } from './slow-query-log'
import { createSqliteTaskStore } from './tasks'
import { createSqliteTokenStore } from './tokens'
import { createSqliteTranscriptStore } from './transcripts'

export function createSqliteDriver(config: StoreConfig): StoreDriver {
  const filename = config.filename ?? join(config.dataDir ?? '.', 'store.db')
  const rawDb = new Database(filename, { strict: true })

  // Migrations and schema creation run against the RAW handle: they are one-off
  // startup DDL, they are legitimately slow, and logging them would bury the
  // steady-state queries this exists to surface.
  migrateSessionColumns(rawDb)
  migrateMessages(rawDb)
  createSchema(rawDb)

  const thresholdMs = slowQueryThresholdMs()
  const { db, stats } = instrumentDatabase(rawDb, { thresholdMs })
  if (thresholdMs > 0) {
    console.log(`[slow-query] logging SQLite calls >= ${thresholdMs}ms (${filename})`)
  }
  const stopSummary = startQueryStatsSummary(stats, queryStatsIntervalMs())

  return {
    conversations: createSqliteConversationStore(db),
    transcripts: createSqliteTranscriptStore(db),
    events: createSqliteEventStore(db),
    kv: createSqliteKVStore(db),
    messages: createSqliteMessageStore(db),
    shares: createSqliteShareStore(db),
    addressBook: createSqliteAddressBookStore(db),
    scopeLinks: createSqliteScopeLinkStore(db),
    tasks: createSqliteTaskStore(db),
    scheduledTasks: createSqliteScheduledTaskStore(db),
    costs: createSqliteCostStore(db),
    tokens: createSqliteTokenStore(db),

    init() {},

    close() {
      stopSummary?.()
      rawDb.close()
    },

    compact() {
      // Raw handle: a VACUUM over a multi-GB store takes minutes by design, and
      // reporting it as a slow query is noise, not signal.
      rawDb.run('PRAGMA wal_checkpoint(TRUNCATE)')
      rawDb.run('VACUUM')
    },
  }
}
