/**
 * Commit ledger queries -- the four axes the ledger is FOR: by conversation,
 * by project, by touched path, and by full text.
 *
 * Filters compose (project + text + origin all narrow the same result set) and
 * every one of them is index-backed except the path substring, which is a scan
 * over an already-narrowed set.
 */

import type { CommitQuery, CommitRow } from '../../shared/commit-ledger'
import { projectIdentityKey } from '../../shared/project-uri'
import { commitColumns, type RawCommitRow, toCommitRow } from './row'
import { commitLedgerDb, isCommitLedgerReady } from './store'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

type Params = Record<string, string | number>

/** FTS5 rejects bare punctuation and unbalanced quotes with a hard throw. Users
 *  type both, so every term is quoted and the whole thing becomes a phrase-ish
 *  AND query -- predictable, and it can't be made to error. */
function ftsQuery(text: string): string {
  const terms = text
    .split(/\s+/)
    .map(t => t.replace(/"/g, '').trim())
    .filter(t => t.length > 0)
  return terms.map(t => `"${t}"`).join(' ')
}

interface Where {
  clauses: string[]
  params: Params
  join: string
  order: string
}

function buildWhere(query: CommitQuery): Where {
  const clauses: string[] = []
  const params: Params = {}
  let join = ''
  let order = 'c.committed_at DESC'

  if (query.conversationId) {
    clauses.push('c.conversation_id = $conversationId')
    params.conversationId = query.conversationId
  }

  if (query.projectUris?.length) {
    // Match repo_uri OR cwd_uri: a conversation launched inside a worktree
    // carries the worktree URI while the ledger's repo_uri is the main repo
    // root, and a project page must show both.
    const ors = query.projectUris.flatMap((uri, i) => {
      params[`uri${i}`] = projectIdentityKey(uri)
      return [`c.repo_uri = $uri${i}`, `c.cwd_uri = $uri${i}`]
    })
    clauses.push(`(${ors.join(' OR ')})`)
  }

  if (query.text) {
    const match = ftsQuery(query.text)
    if (match) {
      // The fts5 table must stay UNALIASED: `f MATCH ...` / `f.rank` are both
      // "no such column" errors, verified against bun:sqlite 1.3.14.
      join = 'JOIN commits_fts ON commits_fts.rowid = c.id'
      clauses.push('commits_fts MATCH $match')
      params.match = match
      order = 'commits_fts.rank, c.committed_at DESC'
    }
  }

  if (query.path) {
    clauses.push('c.files LIKE $path')
    params.path = `%${query.path}%`
  }

  if (query.origin) {
    clauses.push('c.origin = $origin')
    params.origin = query.origin
  }

  if (!query.includeSuperseded) clauses.push('c.superseded_by IS NULL')

  return { clauses, params, join, order }
}

export function queryCommits(query: CommitQuery): CommitRow[] {
  if (!isCommitLedgerReady()) return []
  const { clauses, params, join, order } = buildWhere(query)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(query.offset ?? 0, 0)
  const sql = `SELECT ${commitColumns('c')}
    FROM commits c ${join} ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`
  return (commitLedgerDb().prepare(sql).all(params) as RawCommitRow[]).map(toCommitRow)
}

export function countCommits(query: CommitQuery): number {
  if (!isCommitLedgerReady()) return 0
  const { clauses, params, join } = buildWhere(query)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const row = commitLedgerDb().prepare(`SELECT COUNT(*) AS n FROM commits c ${join} ${where}`).get(params) as {
    n: number
  }
  return row.n
}

export interface LedgerStats {
  total: number
  agent: number
  human: number
  projects: number
  conversations: number
  hosts: number
}

export function ledgerStats(): LedgerStats {
  if (!isCommitLedgerReady()) return { total: 0, agent: 0, human: 0, projects: 0, conversations: 0, hosts: 0 }
  return commitLedgerDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(origin = 'agent') AS agent,
              SUM(origin = 'human') AS human,
              COUNT(DISTINCT repo_uri) AS projects,
              COUNT(DISTINCT conversation_id) AS conversations,
              COUNT(DISTINCT host) AS hosts
       FROM commits`,
    )
    .get() as LedgerStats
}
