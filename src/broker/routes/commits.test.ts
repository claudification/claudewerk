/**
 * Commit ledger HTTP routes -- ingest auth, the enrichment the broker does on
 * top of the hook's payload, permission filtering on reads, and the
 * hash -> transcript join.
 *
 * The ingest-auth predicate is INJECTED rather than module-mocked:
 * `mock.module('../auth-routes')` is process-global under `bun test` and takes
 * down every other route suite that imports from it.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommitRow } from '../../shared/commit-ledger'
import { resetCommitCounts } from '../commit-ledger/counts'
import { closeCommitLedger, initCommitLedger } from '../commit-ledger/store'
import type { ConversationStore } from '../conversation-store'
import type { StoreDriver } from '../store/types'
import { createCommitsRouter } from './commits'
import type { RouteHelpers } from './shared'

const VALID_BEARER = 'good-secret'
const REPO = 'claude://default/Users/x/proj'
let dir: string
let permitted = true
let shareScopedTo: string | null = null
let transcriptEntries: Array<{ seq: number; uuid: string; timestamp: number }> = []

/** A fake control-panel socket. `data` mirrors the real `WsData` fields the
 *  commit broadcast filters on, so these tests exercise the ACTUAL gate rather
 *  than a stand-in for it. */
interface FakeSocket {
  label: string
  data: Record<string, unknown>
  received: Array<Record<string, unknown>>
}

function socket(label: string, data: Record<string, unknown> = {}): FakeSocket {
  const s: FakeSocket = { label, data, received: [] }
  return s
}

let sockets: FakeSocket[] = []

function got(label: string, type: string): boolean {
  return sockets.find(s => s.label === label)?.received.some(m => m.type === type) ?? false
}

function makeApp() {
  const conversationStore = {
    getConversation: (id: string) =>
      id === 'conv-1'
        ? { id, agentName: 'blazing-pretzel', resolvedProfile: 'work', project: REPO, status: 'active' }
        : undefined,
    getSubscribers: () =>
      sockets.map(s => ({
        data: s.data,
        send: (raw: string) => s.received.push(JSON.parse(raw)),
      })),
    // DELIBERATELY ABSENT: any unscoped broadcast helper. A commit row carries
    // the message and every touched path; if the code ever reaches for the
    // blanket path again this fake throws instead of silently leaking.
  } as unknown as ConversationStore
  const store = {
    transcripts: { find: () => transcriptEntries },
  } as unknown as StoreDriver
  const helpers = {
    httpHasPermission: () => permitted,
    httpIsAdmin: () => permitted,
    shareScopedConversationId: () => shareScopedTo,
  } as unknown as RouteHelpers
  const ingestAuth = (req: Request) => req.headers.get('authorization') === `Bearer ${VALID_BEARER}`
  return createCommitsRouter(conversationStore, store, helpers, ingestAuth)
}

function ingest(body: Record<string, unknown>, token = VALID_BEARER) {
  return makeApp().request('/api/commits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** `Response.json()` is `unknown`, so each read states the shape it expects --
 *  which doubles as the assertion that the route still returns it. */
async function readJson<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

type ListBody = { commits: CommitRow[]; total: number }
type IngestBody = { ok: boolean; id: number; duplicate: boolean }
type TranscriptBody = {
  conversationId: string | null
  anchor: { seq: number; uuid: string; timestamp: number } | null
  reason?: string
}

const PAYLOAD = {
  hash: 'a'.repeat(40),
  parents: 'b'.repeat(40),
  repoUri: REPO,
  cwdUri: `${REPO}/.claude/worktrees/feature`,
  branch: 'feature',
  subject: 'fix(ledger): record it',
  files: [{ status: 'M', path: 'src/broker/auth.ts' }],
  committedAt: 1_700_000_000_000,
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'commit-routes-test-'))
  initCommitLedger(dir)
  resetCommitCounts()
  permitted = true
  shareScopedTo = null
  transcriptEntries = []
  sockets = [
    // No grants at all = the owner's own admin panel.
    socket('owner-full', { commitMode: 'full' }),
    socket('owner-counts', { commitMode: 'counts' }),
    socket('owner-default', {}),
    socket('share-guest', { commitMode: 'full', shareToken: 'tok', shareConversationId: 'conv-1' }),
    socket('other-project', { commitMode: 'full', grants: [{ project: 'claude://default/elsewhere', role: 'admin' }] }),
  ]
})

afterEach(() => {
  closeCommitLedger()
  rmSync(dir, { recursive: true, force: true })
})

test('ingest without a valid secret stores nothing', async () => {
  const res = await ingest(PAYLOAD, 'wrong-secret')
  expect(res.status).toBe(401)
  const list = await readJson<ListBody>(makeApp().request('/api/commits'))
  expect(list.commits).toHaveLength(0)
})

test('ingest records the commit and enriches it from the broker registry', async () => {
  const res = await ingest({ ...PAYLOAD, conversationId: 'conv-1' })
  expect(res.status).toBe(202)

  const body = await readJson<ListBody>(makeApp().request('/api/commits?conversation=conv-1'))
  expect(body.commits).toHaveLength(1)
  // The broker enriches from its OWN registry -- the hook never knew the profile.
  expect(body.commits[0].profile).toBe('work')
  expect(body.commits[0].conversationName).toBe('blazing-pretzel')
  expect(body.commits[0].origin).toBe('agent')
})

test('a repeated commit reports as a duplicate rather than failing', async () => {
  expect((await ingest(PAYLOAD)).status).toBe(202)
  const second = await ingest(PAYLOAD)
  expect(second.status).toBe(200)
  expect((await readJson<IngestBody>(second)).duplicate).toBe(true)
})

test('a malformed payload is rejected, not stored', async () => {
  const res = await ingest({ ...PAYLOAD, hash: 'not-a-hash' })
  expect(res.status).toBe(400)
})

test('reads are permission filtered', async () => {
  await ingest(PAYLOAD)
  permitted = false
  const body = await readJson<ListBody>(makeApp().request('/api/commits'))
  expect(body.commits).toHaveLength(0)
})

test('the hash resolves to the conversation and its transcript position', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'conv-1' })
  transcriptEntries = [{ seq: 41, uuid: 'u-41', timestamp: 1_699_999_999_000 }]
  const body = await readJson<TranscriptBody>(makeApp().request(`/api/commits/${'a'.repeat(40)}/transcript`))
  expect(body.conversationId).toBe('conv-1')
  expect(body.anchor).toEqual({ seq: 41, uuid: 'u-41', timestamp: 1_699_999_999_000 })
})

test('a human terminal commit resolves to no conversation, with a reason', async () => {
  await ingest(PAYLOAD)
  const body = await readJson<TranscriptBody>(makeApp().request(`/api/commits/${'a'.repeat(40)}/transcript`))
  expect(body.conversationId).toBeNull()
  expect(body.reason).toContain('not made inside a conversation')
})

// ─── Broadcast tiers + the leak this replaced ─────────────────────────
//
// The first version broadcast full commit rows through an UNSCOPED helper, so
// every connected panel -- share-link guests included -- received the message
// and every touched path for every project. These tests are the fence.

test('only sockets that opted into full rows receive commit_recorded', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'conv-1' })
  expect(got('owner-full', 'commit_recorded')).toBe(true)
  expect(got('owner-counts', 'commit_recorded')).toBe(false)
  // No mode set at all must behave like counts, never like full.
  expect(got('owner-default', 'commit_recorded')).toBe(false)
})

test('a share-link guest never receives a full commit row', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'conv-1' })
  // Bound to the very conversation that committed, and asking for full -- still
  // refused, because repoUri/cwdUri are host disk paths.
  expect(got('share-guest', 'commit_recorded')).toBe(false)
  // The count is fine: it discloses nothing the guest cannot already see.
  expect(got('share-guest', 'commit_count')).toBe(true)
})

test('a socket without chat:read on the project receives nothing at all', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'conv-1' })
  expect(got('other-project', 'commit_recorded')).toBe(false)
  expect(got('other-project', 'commit_count')).toBe(false)
})

test('the count broadcast carries the running total', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'conv-1' })
  await ingest({ ...PAYLOAD, hash: 'c'.repeat(40), conversationId: 'conv-1' })
  const counts = sockets
    .find(s => s.label === 'owner-counts')
    ?.received.filter(m => m.type === 'commit_count')
    .map(m => m.commitCount)
  expect(counts).toEqual([1, 2])
})

test('a human commit broadcasts the row but no count (it has no conversation)', async () => {
  await ingest(PAYLOAD)
  expect(got('owner-full', 'commit_recorded')).toBe(true)
  expect(got('owner-counts', 'commit_count')).toBe(false)
})

// ─── Disclosure oracles ───────────────────────────────────────────────

test('total counts only what the caller may see, not the whole ledger', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'conv-1' })
  await ingest({ ...PAYLOAD, hash: 'c'.repeat(40) })
  permitted = false
  const body = await readJson<ListBody>(makeApp().request('/api/commits'))
  // An unfiltered COUNT(*) next to a filtered list tells the caller exactly how
  // much work exists in projects they cannot read.
  expect(body.commits).toHaveLength(0)
  expect(body.total).toBe(0)
})

test('a share guest gets repo-relative paths but no host disk paths', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'conv-1', repoName: 'proj' })
  shareScopedTo = 'conv-1'
  const body = await readJson<ListBody>(makeApp().request('/api/commits?conversation=conv-1'))
  const row = body.commits[0]
  expect(row.repoUri).toBe('repo://proj')
  expect(row.cwdUri).toBe('repo://proj')
  expect(row.repoUri).not.toContain('/Users/')
  expect(row.host).toBe('')
  expect(row.authorEmail).toBe('')
  // The touched paths are the point of the view and stay.
  expect(row.files[0].path).toBe('src/broker/auth.ts')
})

// ─── Feed ─────────────────────────────────────────────────────────────

test('the feed returns rows newest-first with decorations and a cursor', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'conv-1', committedAt: 1_700_000_000_000 })
  await ingest({ ...PAYLOAD, hash: 'c'.repeat(40), committedAt: 1_700_000_900_000 })
  const feed = await readJson<{
    commits: CommitRow[]
    conversations: Array<{ id: string; status: string }>
    projects: Array<{ uri: string; label: string }>
    cursor: string | null
  }>(makeApp().request('/api/commits/feed'))

  expect(feed.commits.map(c => c.shortHash)).toEqual(['cccccccc', 'aaaaaaaa'])
  expect(feed.projects[0].label).toBe('proj')
  expect(feed.conversations.find(c => c.id === 'conv-1')?.status).toBe('active')
  expect(feed.cursor).toContain(':')
})

test('a commit whose conversation is gone still decorates, as gone', async () => {
  await ingest({ ...PAYLOAD, conversationId: 'vanished-conv' })
  const feed = await readJson<{ conversations: Array<{ id: string; status: string }> }>(
    makeApp().request('/api/commits/feed'),
  )
  // The ledger outlives its conversations -- that is information, not an error.
  expect(feed.conversations.find(c => c.id === 'vanished-conv')?.status).toBe('gone')
})
