import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runStartupMigration, SCHEMA_VERSION } from '../migrate'
import { createSqliteDriver } from '../sqlite/driver'
import type { StoreDriver } from '../types'

/**
 * v7 worktree-path strip migration tests.
 *
 * A worktree IS the same project on a branch (see WORK MODE covenant).
 * `/.claude/worktrees/<name>` path segments split the project bucket for
 * the same folder and break spawn-lineage grouping. v7 rewrites every
 * persisted URI to fold the worktree back into its parent repo and relies
 * on UPDATE OR IGNORE + DELETE to merge with any pre-existing parent-repo
 * row owning the same identity.
 */
describe('v7: /.claude/worktrees/<name> strip migration', () => {
  let cacheDir: string
  let store: StoreDriver

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'worktree-strip-test-'))
    store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    store.init()
  })

  afterEach(() => {
    store.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  // --- helpers --------------------------------------------------------------

  function seedAndRewind(seed: (db: Database) => void): void {
    // Stamp at v6 so v7 (and only v7) fires on the next startup migration.
    store.kv.set('schema-version', 6)
    store.close?.()
    {
      const db = new Database(join(cacheDir, 'store.db'))
      try {
        seed(db)
      } finally {
        db.close()
      }
    }
    store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    store.init()
  }

  function openStore(): Database {
    return new Database(join(cacheDir, 'store.db'))
  }

  // --- tests ---------------------------------------------------------------

  it('rewrites turns.project_uri', () => {
    seedAndRewind(db => {
      db.prepare(
        `INSERT INTO turns (timestamp, conversation_id, project_uri, account, model, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Date.now(),
        'conv_a',
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x',
        'acct',
        'sonnet',
        10,
        20,
      )
    })

    const result = runStartupMigration(store, cacheDir)
    expect(result.toVersion).toBe(SCHEMA_VERSION)
    expect(result.worktreeStripped?.storeTurns.updated).toBe(1)
    expect(result.worktreeStripped?.storeTurns.deleted).toBe(0)

    const db = openStore()
    try {
      const row = db.prepare("SELECT project_uri FROM turns WHERE conversation_id = 'conv_a'").get() as {
        project_uri: string
      }
      expect(row.project_uri).toBe('claude://default/Users/jonas/projects/foo')

      const leftover = db
        .prepare("SELECT COUNT(*) AS n FROM turns WHERE project_uri LIKE '%/.claude/worktrees/%'")
        .get() as {
        n: number
      }
      expect(leftover.n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('preserves trailing path after a worktree segment', () => {
    seedAndRewind(db => {
      db.prepare(
        `INSERT INTO turns (timestamp, conversation_id, project_uri, account, model, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Date.now(),
        'conv_sub',
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x/src/bar.ts',
        'acct',
        'sonnet',
        1,
        2,
      )
    })

    runStartupMigration(store, cacheDir)

    const db = openStore()
    try {
      const row = db.prepare("SELECT project_uri FROM turns WHERE conversation_id = 'conv_sub'").get() as {
        project_uri: string
      }
      expect(row.project_uri).toBe('claude://default/Users/jonas/projects/foo/src/bar.ts')
    } finally {
      db.close()
    }
  })

  it('collapses nested worktrees in a single pass', () => {
    seedAndRewind(db => {
      db.prepare(
        `INSERT INTO turns (timestamp, conversation_id, project_uri, account, model, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Date.now(),
        'conv_nested',
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/a/.claude/worktrees/b',
        'acct',
        'sonnet',
        1,
        2,
      )
    })

    runStartupMigration(store, cacheDir)

    const db = openStore()
    try {
      const row = db.prepare("SELECT project_uri FROM turns WHERE conversation_id = 'conv_nested'").get() as {
        project_uri: string
      }
      expect(row.project_uri).toBe('claude://default/Users/jonas/projects/foo')
    } finally {
      db.close()
    }
  })

  it('rewrites conversations.scope', () => {
    seedAndRewind(db => {
      db.prepare('INSERT INTO conversations (id, scope, agent_type, created_at) VALUES (?, ?, ?, ?)').run(
        'conv_b',
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x',
        'claude',
        Date.now(),
      )
    })

    runStartupMigration(store, cacheDir)

    const db = openStore()
    try {
      const row = db.prepare("SELECT scope FROM conversations WHERE id = 'conv_b'").get() as { scope: string }
      expect(row.scope).toBe('claude://default/Users/jonas/projects/foo')
    } finally {
      db.close()
    }
  })

  it('rewrites scope_links scope_a and scope_b', () => {
    seedAndRewind(db => {
      db.prepare('INSERT INTO scope_links (scope_a, scope_b, created_at) VALUES (?, ?, ?)').run(
        'claude://default/foo/.claude/worktrees/wt-1',
        'claude://default/bar',
        Date.now(),
      )
      db.prepare('INSERT INTO scope_links (scope_a, scope_b, created_at) VALUES (?, ?, ?)').run(
        'claude://default/baz',
        'claude://default/qux/.claude/worktrees/wt-2',
        Date.now(),
      )
    })

    runStartupMigration(store, cacheDir)

    const db = openStore()
    try {
      const leftover = db
        .prepare(
          "SELECT COUNT(*) AS n FROM scope_links WHERE scope_a LIKE '%/.claude/worktrees/%' OR scope_b LIKE '%/.claude/worktrees/%'",
        )
        .get() as { n: number }
      expect(leftover.n).toBe(0)

      const both = db
        .prepare(
          "SELECT COUNT(*) AS n FROM scope_links WHERE scope_a = 'claude://default/foo' AND scope_b = 'claude://default/bar'",
        )
        .get() as { n: number }
      expect(both.n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('PK-collision: existing parent-repo row wins, worktree duplicate is deleted', () => {
    seedAndRewind(db => {
      // Both rows collapse to the same identity (foo, bar). Existing parent-repo
      // row wins; the worktree-prefixed row is stranded after UPDATE OR IGNORE
      // and gets mopped up by the follow-up DELETE.
      db.prepare('INSERT INTO scope_links (scope_a, scope_b, created_at) VALUES (?, ?, ?)').run(
        'claude://default/projects/x/.claude/worktrees/wt',
        'claude://default/projects/y',
        Date.now(),
      )
      db.prepare('INSERT INTO scope_links (scope_a, scope_b, created_at) VALUES (?, ?, ?)').run(
        'claude://default/projects/x',
        'claude://default/projects/y',
        Date.now() + 1,
      )
    })

    const result = runStartupMigration(store, cacheDir)
    expect(result.worktreeStripped?.storeScopeLinks.deleted).toBeGreaterThanOrEqual(1)

    const db = openStore()
    try {
      const survivors = db
        .prepare(
          "SELECT COUNT(*) AS n FROM scope_links WHERE scope_a = 'claude://default/projects/x' AND scope_b = 'claude://default/projects/y'",
        )
        .get() as { n: number }
      expect(survivors.n).toBe(1)
      const wt = db
        .prepare("SELECT COUNT(*) AS n FROM scope_links WHERE scope_a LIKE '%/.claude/worktrees/%'")
        .get() as { n: number }
      expect(wt.n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('rewrites hourly_stats by deletion (PK contains project_uri)', () => {
    seedAndRewind(db => {
      db.prepare(
        `INSERT INTO hourly_stats (hour, account, model, project_uri, turn_count, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('2026-05-26-00', 'acct', 'sonnet', 'claude://default/foo/.claude/worktrees/wt', 1, 10, 20)
    })

    const result = runStartupMigration(store, cacheDir)
    expect(result.worktreeStripped?.storeHourlyDeleted).toBe(1)

    const db = openStore()
    try {
      const leftover = db
        .prepare("SELECT COUNT(*) AS n FROM hourly_stats WHERE project_uri LIKE '%/.claude/worktrees/%'")
        .get() as {
        n: number
      }
      expect(leftover.n).toBe(0)
    } finally {
      db.close()
    }
  })

  it('rewrites message_queue from_scope and to_scope', () => {
    seedAndRewind(db => {
      db.prepare(
        `INSERT INTO message_queue (from_scope, to_scope, content, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'claude://default/a/.claude/worktrees/wt',
        'claude://default/b',
        'hello',
        Date.now(),
        Date.now() + 3600000,
      )
    })

    runStartupMigration(store, cacheDir)

    const db = openStore()
    try {
      const row = db.prepare('SELECT from_scope, to_scope FROM message_queue').get() as {
        from_scope: string
        to_scope: string
      }
      expect(row.from_scope).toBe('claude://default/a')
      expect(row.to_scope).toBe('claude://default/b')
    } finally {
      db.close()
    }
  })

  it('rewrites recaps.project_uri when recap schema is present', () => {
    seedAndRewind(db => {
      db.prepare(
        `INSERT INTO recaps (id, project_uri, period_label, period_start, period_end, time_zone, status, created_at, signals_json, signals_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'recap_w1',
        'claude://default/Users/jonas/projects/foo/.claude/worktrees/feature-x',
        'today',
        Date.now() - 86400000,
        Date.now(),
        'UTC',
        'done',
        Date.now(),
        '{}',
        'hash',
      )
    })

    runStartupMigration(store, cacheDir)

    const db = openStore()
    try {
      const row = db.prepare("SELECT project_uri FROM recaps WHERE id = 'recap_w1'").get() as {
        project_uri: string
      }
      expect(row.project_uri).toBe('claude://default/Users/jonas/projects/foo')
    } finally {
      db.close()
    }
  })

  it('migration is idempotent: re-running is a no-op', () => {
    const first = runStartupMigration(store, cacheDir)
    expect(first.toVersion).toBe(SCHEMA_VERSION)
    const second = runStartupMigration(store, cacheDir)
    expect(second.skipped).toBe(true)
  })

  it('no-op on a DB with zero worktree-prefixed rows', () => {
    seedAndRewind(db => {
      // A non-worktree row should pass through untouched.
      db.prepare('INSERT INTO conversations (id, scope, agent_type, created_at) VALUES (?, ?, ?, ?)').run(
        'conv_clean',
        'claude://default/Users/jonas/projects/foo',
        'claude',
        Date.now(),
      )
    })

    const result = runStartupMigration(store, cacheDir)
    expect(result.worktreeStripped?.storeTurns.updated).toBe(0)
    expect(result.worktreeStripped?.storeTurns.deleted).toBe(0)
    expect(result.worktreeStripped?.storeHourlyDeleted).toBe(0)
    expect(result.worktreeStripped?.storeConversations.updated).toBe(0)

    const db = openStore()
    try {
      const row = db.prepare("SELECT scope FROM conversations WHERE id = 'conv_clean'").get() as { scope: string }
      expect(row.scope).toBe('claude://default/Users/jonas/projects/foo')
    } finally {
      db.close()
    }
  })
})
