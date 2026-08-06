/**
 * Commit ledger schema -- `{cacheDir}/commits.db`.
 *
 * Own database, like projects.db / analytics.db: an append-only side-ledger has
 * no business widening `StoreDriver` (which would force a parallel memory-driver
 * implementation for zero gain). FTS5 mirrors the proven `transcript_fts` shape:
 * external-content table + ai/ad/au triggers.
 */

import type { Database } from 'bun:sqlite'

export function createCommitSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS commits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      short_hash TEXT NOT NULL,
      parent_hashes TEXT NOT NULL DEFAULT '',
      repo_uri TEXT NOT NULL,
      cwd_uri TEXT NOT NULL,
      repo_name TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      is_worktree INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT,
      conversation_name TEXT,
      sentinel TEXT NOT NULL DEFAULT 'default',
      profile TEXT,
      host TEXT NOT NULL DEFAULT 'unknown',
      container TEXT NOT NULL DEFAULT '',
      os_user TEXT NOT NULL DEFAULT '',
      author_name TEXT NOT NULL DEFAULT '',
      author_email TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      files TEXT NOT NULL DEFAULT '[]',
      file_count INTEGER NOT NULL DEFAULT 0,
      files_truncated INTEGER NOT NULL DEFAULT 0,
      insertions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'normal',
      cc_type TEXT,
      cc_scope TEXT,
      cc_breaking INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL DEFAULT 'human',
      superseded_by TEXT,
      fts_doc TEXT NOT NULL DEFAULT '',
      committed_at INTEGER NOT NULL,
      ingested_at INTEGER NOT NULL,
      UNIQUE(hash, repo_uri)
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_commits_conversation ON commits(conversation_id, committed_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo_uri, committed_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_commits_cwd ON commits(cwd_uri, committed_at DESC)')
  db.run('CREATE INDEX IF NOT EXISTS idx_commits_hash ON commits(hash)')
  db.run('CREATE INDEX IF NOT EXISTS idx_commits_committed_at ON commits(committed_at DESC)')
  // Amend supersession scans (repo, parents, not-yet-superseded).
  db.run('CREATE INDEX IF NOT EXISTS idx_commits_amend ON commits(repo_uri, parent_hashes)')

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS commits_fts USING fts5(
      fts_doc,
      content=commits,
      content_rowid=id,
      tokenize='porter unicode61'
    )
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS commits_fts_ai AFTER INSERT ON commits BEGIN
      INSERT INTO commits_fts(rowid, fts_doc) VALUES (new.id, new.fts_doc);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS commits_fts_ad AFTER DELETE ON commits BEGIN
      INSERT INTO commits_fts(commits_fts, rowid, fts_doc) VALUES ('delete', old.id, old.fts_doc);
    END
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS commits_fts_au AFTER UPDATE ON commits BEGIN
      INSERT INTO commits_fts(commits_fts, rowid, fts_doc) VALUES ('delete', old.id, old.fts_doc);
      INSERT INTO commits_fts(rowid, fts_doc) VALUES (new.id, new.fts_doc);
    END
  `)
}
