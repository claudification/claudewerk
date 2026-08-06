/**
 * Commit ledger HTTP routes -- ingest auth, the enrichment the broker does on
 * top of the hook's payload, permission filtering on reads, and the
 * hash -> transcript join.
 *
 * `resolveAuth` is mocked so the test can flip a request between "valid
 * ingest secret" and "no secret at all" without booting the auth subsystem.
 */

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommitRow } from '../../shared/commit-ledger'
import { closeCommitLedger, initCommitLedger } from '../commit-ledger/store'
import type { ConversationStore } from '../conversation-store'
import type { StoreDriver } from '../store/types'
import type { RouteHelpers } from './shared'

let validBearer = 'good-secret'
mock.module('../auth-routes', () => ({
  resolveAuth: (token: string) => ({ role: token === validBearer ? 'admin' : 'none' }),
  getAuthenticatedUser: () => null,
}))

const { createCommitsRouter } = await import('./commits')

const REPO = 'claude://default/Users/x/proj'
let dir: string
let permitted = true
let broadcasts: Record<string, unknown>[] = []
let transcriptEntries: Array<{ seq: number; uuid: string; timestamp: number }> = []

function makeApp() {
  broadcasts = []
  const conversationStore = {
    getConversation: (id: string) =>
      id === 'conv-1' ? { id, agentName: 'blazing-pretzel', resolvedProfile: 'work' } : undefined,
    getSubscribers: () => [{ send: (raw: string) => broadcasts.push(JSON.parse(raw)) }],
  } as unknown as ConversationStore
  const store = {
    transcripts: { find: () => transcriptEntries },
  } as unknown as StoreDriver
  const helpers = {
    httpHasPermission: () => permitted,
    httpIsAdmin: () => permitted,
  } as unknown as RouteHelpers
  return createCommitsRouter(conversationStore, store, helpers)
}

function ingest(body: Record<string, unknown>, token = validBearer) {
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
  permitted = true
  validBearer = 'good-secret'
  transcriptEntries = []
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

test('ingest records the commit and broadcasts it', async () => {
  const res = await ingest({ ...PAYLOAD, conversationId: 'conv-1' })
  expect(res.status).toBe(202)
  expect(broadcasts[0]?.type).toBe('commit_recorded')

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
