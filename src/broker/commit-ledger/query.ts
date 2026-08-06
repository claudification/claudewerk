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

/** One filter's contribution to the WHERE clause. Returning `null` means the
 *  filter is absent and contributes nothing. */
type Contributor = (query: CommitQuery, params: Params) => string | null

/** The filters, each self-contained. A list beats one long if-chain here: every
 *  entry reads as `what it filters on` next to `the SQL it emits`, and adding a
 *  filter is one array entry rather than another branch. */
const CONTRIBUTORS: Contributor[] = [
  (q, p) => {
    if (!q.conversationId) return null
    p.conversationId = q.conversationId
    return 'c.conversation_id = $conversationId'
  },
  (q, p) => {
    if (!q.projectUris?.length) return null
    // Match repo_uri OR cwd_uri: a conversation launched inside a worktree
    // carries the worktree URI while the ledger's repo_uri is the main repo
    // root, and a project page must show both.
    const ors = q.projectUris.flatMap((uri, i) => {
      p[`uri${i}`] = projectIdentityKey(uri)
      return [`c.repo_uri = $uri${i}`, `c.cwd_uri = $uri${i}`]
    })
    return `(${ors.join(' OR ')})`
  },
  (q, p) => {
    if (!q.path) return null
    p.path = `%${q.path}%`
    return 'c.files LIKE $path'
  },
  (q, p) => {
    if (!q.origin) return null
    p.origin = q.origin
    return 'c.origin = $origin'
  },
  (q, p) => {
    if (q.before == null) return null
    // Keyset pagination on (committed_at, id): a plain timestamp cursor drops
    // rows whenever several commits share one second, which a rebase produces
    // routinely.
    p.before = q.before
    p.beforeId = q.beforeId ?? Number.MAX_SAFE_INTEGER
    return '(c.committed_at < $before OR (c.committed_at = $before AND c.id < $beforeId))'
  },
  q => (q.includeSuperseded ? null : 'c.superseded_by IS NULL'),
]

/** Full-text search is the one filter that also changes the FROM and the ORDER,
 *  so it stays out of the contributor list rather than pretending to fit it. */
function applyText(query: CommitQuery, params: Params): { clause: string | null; join: string; order: string } {
  const match = query.text ? ftsQuery(query.text) : ''
  if (!match) return { clause: null, join: '', order: 'c.committed_at DESC' }
  params.match = match
  // The fts5 table must stay UNALIASED: `f MATCH ...` / `f.rank` are both
  // "no such column" errors, verified against bun:sqlite 1.3.14.
  return {
    clause: 'commits_fts MATCH $match',
    join: 'JOIN commits_fts ON commits_fts.rowid = c.id',
    order: 'commits_fts.rank, c.committed_at DESC',
  }
}

function buildWhere(query: CommitQuery): Where {
  const params: Params = {}
  const text = applyText(query, params)
  const clauses = [text.clause, ...CONTRIBUTORS.map(fn => fn(query, params))].filter((c): c is string => c !== null)
  return { clauses, params, join: text.join, order: text.order }
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

/** Count only the rows a caller may actually see.
 *
 *  A plain `COUNT(*)` next to a permission-filtered list is a DISCLOSURE
 *  ORACLE -- `{commits: [], total: 412}` tells the caller exactly how much work
 *  exists in projects they cannot read. Selecting just the two identity columns
 *  keeps this an index-only scan over the same narrowed set, so the honest
 *  answer costs about what the dishonest one did.
 */
export function countVisibleCommits(
  query: CommitQuery,
  isVisible: (repoUri: string, conversationId: string | null) => boolean,
): number {
  if (!isCommitLedgerReady()) return 0
  const { clauses, params, join } = buildWhere(query)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = commitLedgerDb()
    .prepare(`SELECT c.repo_uri AS repoUri, c.conversation_id AS conversationId FROM commits c ${join} ${where}`)
    .all(params) as Array<{ repoUri: string; conversationId: string | null }>
  let n = 0
  for (const row of rows) if (isVisible(row.repoUri, row.conversationId)) n++
  return n
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
      // COALESCE: SUM() over ZERO rows is NULL, not 0 -- an empty ledger would
      // otherwise serve `{agent: null, human: null}` to the panel.
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(origin = 'agent'), 0) AS agent,
              COALESCE(SUM(origin = 'human'), 0) AS human,
              COUNT(DISTINCT repo_uri) AS projects,
              COUNT(DISTINCT conversation_id) AS conversations,
              COUNT(DISTINCT host) AS hosts
       FROM commits`,
    )
    .get() as LedgerStats
}
