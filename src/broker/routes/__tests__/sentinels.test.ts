/**
 * Tests for /api/sentinels -- sentinel-profiles Phase 3 deliverable.
 *
 * Covers the slice that Phase 3 touches: the list endpoint must surface
 * each connected sentinel's reported `profiles[]` + `defaultSelection`,
 * sourced from the in-memory SentinelConnection state (NEVER from disk --
 * profiles are sentinel-local and re-reported on every identify).
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import type { ProfileUsageSnapshot, SentinelProfileInfo } from '../../../shared/protocol'
import { setRclaudeSecret } from '../../auth-routes'
import { type ConversationStore, createConversationStore } from '../../conversation-store'
import { createSentinelRegistry, type SentinelRegistry } from '../../sentinel-registry'
import { createMemoryDriver } from '../../store/memory/driver'
import type { StoreDriver } from '../../store/types'
import { createSentinelRouter } from '../sentinels'
import { createRouteHelpers, type RouteHelpers } from '../shared'

const TEST_SECRET = 'test-secret-sentinels-42'

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_SECRET}` }
}

let app: Hono
let store: StoreDriver
let conversationStore: ConversationStore
let helpers: RouteHelpers
let sentinelRegistry: SentinelRegistry

function makeFakeWs(): ServerWebSocket<unknown> {
  return {
    data: {},
    readyState: 1,
    send: () => 0,
    close: () => {},
  } as unknown as ServerWebSocket<unknown>
}

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  setRclaudeSecret(TEST_SECRET)
  helpers = createRouteHelpers(TEST_SECRET)

  const cacheDir = mkdtempSync(join(tmpdir(), 'rclaude-sentinels-test-'))
  sentinelRegistry = createSentinelRegistry(cacheDir)

  app = new Hono()
  app.route('/', createSentinelRouter(sentinelRegistry, conversationStore, helpers))
})

async function listSentinels(): Promise<Array<Record<string, unknown>>> {
  const res = await app.request('/api/sentinels', { headers: authHeaders() })
  expect(res.status).toBe(200)
  return (await res.json()) as Array<Record<string, unknown>>
}

describe('GET /api/sentinels', () => {
  it('returns 403 without admin auth', async () => {
    const res = await app.request('/api/sentinels')
    expect(res.status).toBe(403)
  })

  it('returns empty list when no sentinels are registered', async () => {
    expect(await listSentinels()).toEqual([])
  })

  it('returns sentinels without profiles when none reported', async () => {
    const record = sentinelRegistry.create({ alias: 'lonely', generateSecret: true })
    conversationStore.setSentinel(makeFakeWs(), {
      sentinelId: record.sentinelId,
      alias: record.aliases[0],
      hostname: 'host-lonely',
    })
    const data = await listSentinels()
    expect(data).toHaveLength(1)
    expect(data[0].alias).toBe('lonely')
    expect(data[0].connected).toBe(true)
    expect(data[0].profiles).toBeUndefined()
    expect(data[0].defaultSelection).toBeUndefined()
  })

  it('surfaces reported profiles + pools + defaultPool from a connected sentinel', async () => {
    const record = sentinelRegistry.create({ alias: 'beast', generateSecret: true })
    const profiles: SentinelProfileInfo[] = [
      { name: 'default', pool: 'default', authed: true },
      { name: 'work', label: 'Work org', color: '#f59e0b', pool: null, authed: true },
      { name: 'alt', label: 'Second account', pool: 'default', authed: false },
    ]
    conversationStore.setSentinel(makeFakeWs(), {
      sentinelId: record.sentinelId,
      alias: record.aliases[0],
      hostname: 'beast.local',
      profiles,
      defaultSelection: 'balanced',
      pools: ['default'],
      defaultPool: 'default',
    })
    const data = await listSentinels()
    expect(data).toHaveLength(1)
    expect(data[0].alias).toBe('beast')
    expect(data[0].profiles).toEqual(profiles)
    expect(data[0].defaultSelection).toBe('balanced')
    expect(data[0].pools).toEqual(['default'])
    expect(data[0].defaultPool).toBe('default')
  })

  it('drops profile data when a sentinel disconnects (live-only, not persisted)', async () => {
    const record = sentinelRegistry.create({ alias: 'flap', generateSecret: true })
    const ws = makeFakeWs()
    conversationStore.setSentinel(ws, {
      sentinelId: record.sentinelId,
      alias: record.aliases[0],
      profiles: [{ name: 'default', pool: 'default', authed: true }],
      defaultSelection: 'random',
      pools: ['default'],
      defaultPool: 'default',
    })
    // Disconnect: removeSentinel clears the in-memory SentinelConnection.
    conversationStore.removeSentinel(ws)
    const data = await listSentinels()
    expect(data).toHaveLength(1)
    expect(data[0].connected).toBe(false)
    expect(data[0].profiles).toBeUndefined()
    expect(data[0].defaultSelection).toBeUndefined()
    expect(data[0].pools).toBeUndefined()
    expect(data[0].defaultPool).toBeUndefined()
  })
})

describe('GET /api/sentinels/:id/usage', () => {
  const snapshots: ProfileUsageSnapshot[] = [
    {
      profile: 'default',
      authed: true,
      polledAt: 1000,
      fiveHour: { usedPercent: 12, resetAt: '2026-05-21T15:00:00Z' },
      sevenDay: { usedPercent: 47, resetAt: '2026-05-28T00:00:00Z' },
    },
    { profile: 'work', authed: false, polledAt: 1000, error: { kind: 'no_token' } },
  ]

  it('returns 403 without admin auth', async () => {
    const res = await app.request('/api/sentinels/snt_x/usage')
    expect(res.status).toBe(403)
  })

  it('returns 404 when sentinel is unknown', async () => {
    const res = await app.request('/api/sentinels/snt_does-not-exist/usage', { headers: authHeaders() })
    expect(res.status).toBe(404)
  })

  it('returns 404 when sentinel is connected but has not reported yet', async () => {
    const record = sentinelRegistry.create({ alias: 'fresh', generateSecret: true })
    conversationStore.setSentinel(makeFakeWs(), { sentinelId: record.sentinelId, alias: record.aliases[0] })
    const res = await app.request(`/api/sentinels/${record.sentinelId}/usage`, { headers: authHeaders() })
    expect(res.status).toBe(404)
  })

  it('returns the latest report (sorted by profile name) after the handler stored it', async () => {
    const record = sentinelRegistry.create({ alias: 'beast', generateSecret: true })
    const ws = makeFakeWs()
    conversationStore.setSentinel(ws, { sentinelId: record.sentinelId, alias: record.aliases[0] })
    expect(conversationStore.setSentinelProfileUsage(ws, snapshots, 1000)).toBe(true)

    const res = await app.request(`/api/sentinels/${record.sentinelId}/usage`, { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { profiles: ProfileUsageSnapshot[]; polledAt: number }
    expect(body.polledAt).toBe(1000)
    expect(body.profiles.map(p => p.profile)).toEqual(['default', 'work'])
    expect(body.profiles[0].fiveHour?.usedPercent).toBe(12)
    expect(body.profiles[1].error?.kind).toBe('no_token')
  })

  it('drops the report when the sentinel disconnects', async () => {
    const record = sentinelRegistry.create({ alias: 'gone', generateSecret: true })
    const ws = makeFakeWs()
    conversationStore.setSentinel(ws, { sentinelId: record.sentinelId, alias: record.aliases[0] })
    conversationStore.setSentinelProfileUsage(ws, snapshots, 1000)
    conversationStore.removeSentinel(ws)
    const res = await app.request(`/api/sentinels/${record.sentinelId}/usage`, { headers: authHeaders() })
    expect(res.status).toBe(404)
  })

  it('setSentinelProfileUsage returns false when WS is not associated with any sentinel', () => {
    const orphanWs = makeFakeWs()
    expect(conversationStore.setSentinelProfileUsage(orphanWs, snapshots, 1000)).toBe(false)
  })
})
