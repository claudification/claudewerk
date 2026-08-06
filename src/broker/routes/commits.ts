/**
 * Commit ledger routes -- `/api/commits/*`.
 *
 * Ingest is secret-gated and synchronous (see commit-ledger/store.ts for why no
 * queue). Reads are permission-gated per row on the commit's own project URI,
 * so a share-scoped viewer sees only what their grant covers.
 */

import { Hono } from 'hono'
import type { CommitIngestPayload, CommitQuery, CommitRow } from '../../shared/commit-ledger'
import { findTranscriptAnchor } from '../commit-ledger/anchor'
import { countCommits, ledgerStats, queryCommits } from '../commit-ledger/query'
import { getCommitsByHash } from '../commit-ledger/store'
import type { ConversationStore } from '../conversation-store'
import type { StoreDriver } from '../store/types'
import { hasIngestAuth, ingestCommit } from './commits-ingest'
import type { RouteHelpers } from './shared'

function parseListQuery(url: URL): CommitQuery {
  const projectUris = url.searchParams.getAll('project').filter(Boolean)
  const origin = url.searchParams.get('origin')
  return {
    conversationId: url.searchParams.get('conversation') ?? undefined,
    projectUris: projectUris.length > 0 ? projectUris : undefined,
    text: url.searchParams.get('q') ?? undefined,
    path: url.searchParams.get('path') ?? undefined,
    origin: origin === 'agent' || origin === 'human' ? origin : undefined,
    includeSuperseded: url.searchParams.get('includeSuperseded') === '1',
    limit: Number(url.searchParams.get('limit')) || undefined,
    offset: Number(url.searchParams.get('offset')) || undefined,
  }
}

export function createCommitsRouter(
  conversationStore: ConversationStore,
  store: StoreDriver,
  helpers: RouteHelpers,
): Hono {
  const { httpHasPermission } = helpers
  const app = new Hono()

  /** Rows the caller is allowed to see. Gated on the commit's own repo URI --
   *  and, for a row bound to a conversation, that conversation too, so a share
   *  token scoped to conversation A never leaks conversation B's commits. */
  const visible = (req: Request, rows: CommitRow[]): CommitRow[] =>
    rows.filter(row => httpHasPermission(req, 'chat:read', row.repoUri, row.conversationId ?? undefined))

  // ─── Ingest (git post-commit hook) ──────────────────────────────────
  app.post('/api/commits', async c => {
    if (!hasIngestAuth(c.req.raw)) return c.json({ error: 'Unauthorized' }, 401)
    let payload: CommitIngestPayload
    try {
      payload = (await c.req.json()) as CommitIngestPayload
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400)
    }
    const outcome = ingestCommit(conversationStore, payload)
    return c.json(outcome.body, outcome.status)
  })

  // ─── List / search ──────────────────────────────────────────────────
  app.get('/api/commits', c => {
    const url = new URL(c.req.url)
    const query = parseListQuery(url)
    const rows = visible(c.req.raw, queryCommits(query))
    return c.json({ commits: rows, total: countCommits(query) })
  })

  app.get('/api/commits/stats', c => {
    if (!helpers.httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json(ledgerStats())
  })

  // ─── One commit, and the transcript that produced it ────────────────
  app.get('/api/commits/:hash', c => {
    const rows = visible(c.req.raw, getCommitsByHash(c.req.param('hash')))
    if (rows.length === 0) return c.json({ error: 'Not found' }, 404)
    return c.json({ commit: rows[0], others: rows.slice(1) })
  })

  /** THE JOIN: hash -> the conversation + the transcript position at the moment
   *  it committed. `git blame` gives you a hash; this gives you the reasoning. */
  app.get('/api/commits/:hash/transcript', c => {
    const rows = visible(c.req.raw, getCommitsByHash(c.req.param('hash')))
    const commit = rows[0]
    if (!commit) return c.json({ error: 'Not found' }, 404)
    if (!commit.conversationId) {
      return c.json({ commit, conversationId: null, reason: 'commit was not made inside a conversation' })
    }
    return c.json({
      commit,
      conversationId: commit.conversationId,
      anchor: findTranscriptAnchor(store, commit.conversationId, commit.committedAt),
    })
  })

  return app
}
