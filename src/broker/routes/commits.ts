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
import { countVisibleCommits, ledgerStats, queryCommits } from '../commit-ledger/query'
import { redactCommitsForShareGuest } from '../commit-ledger/redact'
import { getCommitsByHash } from '../commit-ledger/store'
import type { ConversationStore } from '../conversation-store'
import type { StoreDriver } from '../store/types'
import { decorateFeed, nextCursor, parseCursor } from './commits-feed'
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
  /** Injected so tests can authorize without mocking the auth module -- a
   *  `mock.module('../auth-routes')` is process-global under `bun test` and
   *  broke every other route suite that imports from it. */
  ingestAuth: (req: Request) => boolean = hasIngestAuth,
): Hono {
  const { httpHasPermission } = helpers
  const app = new Hono()

  /** Rows the caller is allowed to see, with host paths stripped for share
   *  guests. Gated on the commit's own repo URI -- and, for a row bound to a
   *  conversation, that conversation too, so a share token scoped to
   *  conversation A never leaks conversation B's commits. */
  const visible = (req: Request, rows: CommitRow[]): CommitRow[] => {
    const allowed = rows.filter(row =>
      httpHasPermission(req, 'chat:read', row.repoUri, row.conversationId ?? undefined),
    )
    return redactCommitsForShareGuest(allowed, helpers.shareScopedConversationId(req) !== null)
  }

  /** The count MUST be computed from the permitted rows, not the raw query.
   *  Returning an unfiltered `total` alongside a filtered list is a disclosure
   *  oracle: it tells a caller how much work exists in projects they cannot
   *  read. Costs one narrow scan over an already-indexed result set. */
  const visibleTotal = (req: Request, query: CommitQuery): number =>
    countVisibleCommits(query, (repoUri, conversationId) =>
      httpHasPermission(req, 'chat:read', repoUri, conversationId ?? undefined),
    )

  // ─── Ingest (git post-commit hook) ──────────────────────────────────
  app.post('/api/commits', async c => {
    if (!ingestAuth(c.req.raw)) return c.json({ error: 'Unauthorized' }, 401)
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
    return c.json({ commits: rows, total: visibleTotal(c.req.raw, query) })
  })

  /** The global browser's feed: flat, newest-first, cursor-paginated, plus the
   *  decorations its group headers need. NOT grouped server-side -- see
   *  commits-feed.ts for why that would break run-length headers across pages. */
  app.get('/api/commits/feed', c => {
    const url = new URL(c.req.url)
    const cursor = parseCursor(url.searchParams.get('cursor'))
    const query: CommitQuery = {
      ...parseListQuery(url),
      before: cursor?.before,
      beforeId: cursor?.beforeId,
      limit: Math.min(Number(url.searchParams.get('limit')) || 60, 200),
    }
    const rows = visible(c.req.raw, queryCommits(query))
    return c.json({
      commits: rows,
      ...decorateFeed(conversationStore, rows),
      cursor: nextCursor(rows),
      hasMore: rows.length > 0 && rows.length >= (query.limit ?? 0),
    })
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
