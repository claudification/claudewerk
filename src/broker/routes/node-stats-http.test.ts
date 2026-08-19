/**
 * Card `node-stats-http-ingest`, "Done means":
 *   "POST /api/node-stats accepts a valid frame from an `rpt_` key and feeds the
 *    SAME handler + store as the WS path (asserted by a test that posts a frame
 *    the shared builder produced)"
 *   "A malformed or non-`node_stats` body is refused with a logged reason"
 *
 * This drives the REAL Hono router with the REAL requireAuth middleware in
 * front of it, so a route that only works because the middleware was skipped
 * cannot pass. The frames are produced by `createNodeStatsReporter` -- the same
 * runner the standalone reporter ships -- not hand-written here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { NODE_STATS_INGEST_PATH } from '../../shared/node-stats'
import { FIXTURE_REPORTER_IDENTITY, FIXTURE_SENTINEL_IDENTITY, stubSampler } from '../../shared/node-stats-fixture'
import { createNodeStatsReporter } from '../../shared/node-stats-reporting'
import { addCredential, createUser, getUser, hasAnyUsers, initAuth } from '../auth'
import { requireAuth, setRclaudeSecret, setSentinelRegistry } from '../auth-routes'
import { nodeStatsStore } from '../node-stats-store'
import { createSentinelRegistry } from '../sentinel-registry'
import { createNodeStatsHttpRouter, resetNodeStatsHttpAnnouncements } from './node-stats-http'

const TEST_CACHE_DIR = join(import.meta.dirname, '.test-node-stats-http')
const ADMIN_SECRET = 'admin-secret-for-the-control'

let reporterSecret = ''
let sentinelSecret = ''
let app: Hono
const broadcasts: Record<string, unknown>[] = []

/** The bytes a real sender puts on the wire, produced by the SHARED runner. */
function wireFrame(identity = FIXTURE_REPORTER_IDENTITY): string {
  let json = ''
  createNodeStatsReporter({
    identity,
    sampler: stubSampler,
    sentinelExtras: identity.sender === 'sentinel' ? () => ({ conversationCount: 3 }) : undefined,
    send: report => {
      json = JSON.stringify(report)
    },
  }).tick()
  return json
}

// `app.request` is typed `Response | Promise<Response>`; awaiting it here keeps
// the union off every call site rather than pushing it onto all of them.
async function post(body: string, secret?: string, path = NODE_STATS_INGEST_PATH): Promise<Response> {
  return await app.request(`http://localhost:9999${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body,
  })
}

beforeAll(() => {
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
  mkdirSync(TEST_CACHE_DIR, { recursive: true })
  initAuth({ cacheDir: TEST_CACHE_DIR, skipTimers: true })
  // requireAuth is OPEN until a registered passkey exists, so without a real
  // credential every denial below would pass vacuously.
  //
  // The auth module's user list is PROCESS-GLOBAL and `initAuth` does not clear
  // it, so a name another suite in the same `bun test` run already created
  // throws. Own name, created only if this run has not created it yet.
  const USER = 'node-stats-http-tester'
  if (!getUser(USER)) createUser(USER)
  addCredential(USER, { credentialId: 'cred-nsh', publicKey: 'pk', counter: 0, registeredAt: Date.now() })
  expect(hasAnyUsers()).toBe(true)
  setRclaudeSecret(ADMIN_SECRET)

  const registry = createSentinelRegistry(TEST_CACHE_DIR)
  setSentinelRegistry(registry)
  sentinelSecret = registry.create({ alias: 'studio', generateSecret: true }).rawSecret ?? ''
  reporterSecret = registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' }).rawSecret ?? ''

  // The real middleware in front of the real router -- same order as routes.ts.
  app = new Hono()
  app.use('*', async (c, next) => {
    const block = requireAuth(c.req.raw)
    if (block) return block
    return next()
  })
  app.route(
    '/',
    createNodeStatsHttpRouter({
      getSubscribers: () => [{ send: (json: string) => broadcasts.push(JSON.parse(json)) } as unknown as never],
    } as never),
  )
})

afterAll(() => {
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
  // The admin secret is process-global. Leaving ours armed would hand every
  // later suite in the same run a working admin bearer it never asked for.
  setRclaudeSecret('')
})

beforeEach(() => {
  nodeStatsStore.clear()
  resetNodeStatsHttpAnnouncements()
  broadcasts.length = 0
})

describe('POST /api/node-stats: an rpt_ key ingests vitals over HTTP', () => {
  it('accepts a frame the SHARED builder produced', async () => {
    const res = await post(wireFrame(), reporterSecret)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, machineOwner: true })
  })

  it('feeds the SAME store as the WS path, keyed by the CREDENTIAL not the wire', async () => {
    await post(wireFrame(), reporterSecret)
    expect(nodeStatsStore.size()).toBe(1)
    // The frame says `rpt-node-1`; the row is under the broker-resolved id.
    expect(nodeStatsStore.get(FIXTURE_REPORTER_IDENTITY.nodeId)).toBeUndefined()
    const [row] = nodeStatsStore.nodes()
    expect(row.report.node.sender).toBe('reporter')
    expect(row.report.machine.cpuPercent).toBe(42.5)
  })

  it('broadcasts node_stats_update, exactly as the WS path does', async () => {
    await post(wireFrame(), reporterSecret)
    expect(broadcasts.at(-1)).toMatchObject({ type: 'node_stats_update', machineOwner: true })
  })

  it('ONE ROW PER KEY: two posts on the same key overwrite, they do not double-count', async () => {
    // One-connection-per-key cannot survive a stateless POST -- rows keyed by
    // credential are what replaces it. This is the card's accepted cost, pinned.
    await post(wireFrame(), reporterSecret)
    await post(wireFrame(), reporterSecret)
    expect(nodeStatsStore.size()).toBe(1)
    expect(nodeStatsStore.machines().length).toBe(1)
  })

  it('a sentinel key posts too, extras intact, on the same route', async () => {
    await post(wireFrame(FIXTURE_SENTINEL_IDENTITY), sentinelSecret)
    const [row] = nodeStatsStore.nodes()
    expect(row.report.node.sender).toBe('sentinel')
    expect(row.report.sentinel).toEqual({ conversationCount: 3 })
  })

  it('a sentinel and a reporter on one box: two rows, one machine row', async () => {
    await post(wireFrame(FIXTURE_SENTINEL_IDENTITY), sentinelSecret)
    await post(wireFrame(), reporterSecret)
    expect(nodeStatsStore.size()).toBe(2)
    expect(nodeStatsStore.machines().length).toBe(1)
  })
})

describe('the body must be a node_stats frame and nothing else', () => {
  /** Capture what the route logged for this request. */
  async function postCapturingLogs(body: string, secret: string): Promise<{ status: number; logs: string[] }> {
    const logs: string[] = []
    const spy = mock((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    const original = console.log
    console.log = spy as unknown as typeof console.log
    try {
      const res = await post(body, secret)
      return { status: res.status, logs }
    } finally {
      console.log = original
    }
  }

  it('refuses invalid JSON with a logged reason', async () => {
    const { status, logs } = await postCapturingLogs('{not json', reporterSecret)
    expect(status).toBe(400)
    expect(nodeStatsStore.size()).toBe(0)
    expect(logs.some(l => l.includes('rejected') && l.includes('invalid JSON'))).toBe(true)
  })

  it('refuses a DIFFERENT message type -- this route reads one message', async () => {
    const res = await post(JSON.stringify({ type: 'spawn_conversation', cwd: '/etc' }), reporterSecret)
    expect(res.status).toBe(400)
    expect(nodeStatsStore.size()).toBe(0)
    const body = (await res.json()) as { reasons: string[] }
    expect(body.reasons.some(r => r.includes("type: expected 'node_stats'"))).toBe(true)
  })

  it('refuses a malformed frame with the validator reasons, logged', async () => {
    const { status, logs } = await postCapturingLogs(
      JSON.stringify({ type: 'node_stats', node: { nodeId: 'x' } }),
      reporterSecret,
    )
    expect(status).toBe(400)
    expect(nodeStatsStore.size()).toBe(0)
    expect(logs.some(l => l.includes('rejected') && l.includes('errors='))).toBe(true)
  })

  it('a reporter cannot smuggle sentinel extras by claiming sender=sentinel', async () => {
    const frame = JSON.parse(wireFrame()) as Record<string, unknown>
    frame.node = { ...(frame.node as object), sender: 'sentinel' }
    frame.sentinel = { conversationCount: 99 }
    const res = await post(JSON.stringify(frame), reporterSecret)
    // Stamped back to `reporter` from the credential, so the shared validator's
    // own extras rule then refuses it.
    expect(res.status).toBe(400)
    expect(nodeStatsStore.size()).toBe(0)
  })
})

describe('who may post', () => {
  it('no bearer at all: 401 from the middleware, never reaching the route', async () => {
    const res = await post(wireFrame())
    expect(res.status).toBe(401)
    expect(nodeStatsStore.size()).toBe(0)
  })

  it('a garbage bearer: 401', async () => {
    const res = await post(wireFrame(), 'rpt_nope')
    expect(res.status).toBe(401)
  })

  it('the ADMIN secret authenticates but is not a NODE, so it gets 403 not a fake row', async () => {
    const res = await post(wireFrame(), ADMIN_SECRET)
    expect(res.status).toBe(403)
    expect(nodeStatsStore.size()).toBe(0)
  })

  it('GET on the ingest path is not the ingest request (method is part of the door)', async () => {
    const res = await app.request(`http://localhost:9999${NODE_STATS_INGEST_PATH}`, {
      headers: { authorization: `Bearer ${reporterSecret}` },
    })
    expect(res.status).toBe(401)
  })

  it('a path that merely STARTS with the ingest path is not the ingest path', async () => {
    const res = await post(wireFrame(), reporterSecret, `${NODE_STATS_INGEST_PATH}-secrets`)
    expect(res.status).toBe(401)
  })
})

describe('the identity-stamp line is logged once per NODE, not once per POST', () => {
  it('five posts, one line', async () => {
    // REGRESSION shape from the WS path (2026-08-19): at the 5s cadence an
    // unlatched line is ~17k a day per node saying a node cannot know its own id.
    const logs: string[] = []
    const original = console.log
    console.log = ((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    }) as typeof console.log
    try {
      for (let i = 0; i < 5; i++) await post(wireFrame(), reporterSecret)
    } finally {
      console.log = original
    }
    expect(logs.filter(l => l.includes('identity stamped from credential')).length).toBe(1)
    expect(nodeStatsStore.size()).toBe(1) // still ingesting every post
  })
})
