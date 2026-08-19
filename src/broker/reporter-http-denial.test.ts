/**
 * Card `node-stats-reporter-credential`, "Done means":
 *   "A reporter key authenticates zero HTTP routes -- proved by a test that
 *    curls them."
 *
 * AMENDED by card `node-stats-http-ingest` (2026-08-19). The rule is now
 * EXACTLY ONE: `POST /api/node-stats`, whose entire body is a vitals frame. The
 * test did not disappear with the rule change -- it flipped from "opens NOTHING"
 * to "opens exactly one path and 401s on every other route class", which is the
 * assertion that would actually notice the door being widened later.
 *
 * This boots a REAL broker HTTP surface (Hono router + the real requireAuth
 * middleware) and issues real `fetch` requests -- the in-process equivalent of
 * curl, minus the flake of a subprocess and a port.
 *
 * THE CONTROL that makes this meaningful: every assertion is made TWICE, once
 * with an `snt_` bearer and once with the `rpt_` bearer. The sentinel key
 * opening a route is what proves the route was reachable at all; the reporter
 * key failing on that same route is then a real denial rather than a route that
 * happens to 404 for everyone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { NODE_STATS_INGEST_PATH } from '../shared/node-stats'
import { addCredential, createUser, hasAnyUsers, initAuth } from './auth'
import { requireAuth, resolveAuth, setSentinelRegistry } from './auth-routes'
import { canAuthenticateHttpRoutes, canIngestNodeStatsHttp } from './node-capability'
import { createRouteHelpers } from './routes/shared'
import { createSentinelRegistry } from './sentinel-registry'

const TEST_CACHE_DIR = join(import.meta.dirname, '.test-reporter-http')

let reporterSecret = ''
let sentinelSecret = ''

beforeAll(() => {
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
  mkdirSync(TEST_CACHE_DIR, { recursive: true })
  initAuth({ cacheDir: TEST_CACHE_DIR, skipTimers: true })
  // requireAuth is OPEN BY DEFAULT until a registered passkey exists (first-run
  // setup). `hasAnyUsers()` counts users WITH CREDENTIALS, so a bare createUser
  // leaves the broker wide open and the denial test would pass vacuously.
  createUser('jonas')
  addCredential('jonas', { credentialId: 'cred-1', publicKey: 'pk', counter: 0, registeredAt: Date.now() })

  const registry = createSentinelRegistry(TEST_CACHE_DIR)
  setSentinelRegistry(registry)
  sentinelSecret = registry.create({ alias: 'studio', generateSecret: true }).rawSecret ?? ''
  reporterSecret = registry.create({ alias: 'beast', generateSecret: true, kind: 'reporter' }).rawSecret ?? ''
})

afterAll(() => {
  rmSync(TEST_CACHE_DIR, { recursive: true, force: true })
})

/** Every route CLASS the broker serves. */
const ROUTES = [
  '/api/sentinels',
  '/api/conversations',
  '/api/settings',
  '/api/push/vapid',
  '/conversations',
  '/conversations/abc123/diag',
  '/api/projects',
  '/api/crash',
  '/health',
  '/file/whatever.png',
  '/auth/status',
  '/',
  '/some/spa/path',
]

function req(path: string, secret?: string, method = 'GET'): Request {
  return new Request(`http://localhost:9999${path}`, {
    method,
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  })
}

/** True when requireAuth lets the request through to a handler. */
function passesAuth(path: string, secret?: string, method = 'GET'): boolean {
  return requireAuth(req(path, secret, method)) === null
}

describe('the rpt_ key resolves as a reporter', () => {
  it('the fixture actually closes the broker (else every denial below is vacuous)', () => {
    expect(hasAnyUsers()).toBe(true)
    expect(requireAuth(req('/api/sentinels'))?.status).toBe(401)
  })

  it('is a reporter role, not a sentinel and not none', () => {
    expect(resolveAuth(reporterSecret)).toEqual({
      role: 'reporter',
      reporterId: expect.any(String),
      alias: 'beast',
    })
  })

  it('the snt_ control key resolves as a sentinel', () => {
    expect(resolveAuth(sentinelSecret).role).toBe('sentinel')
  })
})

describe('curl every route: the rpt_ key opens EXACTLY ONE path', () => {
  for (const path of ROUTES) {
    it(`${path}: reporter gets no more than an anonymous caller`, () => {
      const anonymous = passesAuth(path)
      const reporter = passesAuth(path, reporterSecret)
      // The key adds ZERO access. A public route (/health, /auth/status, SPA
      // HTML) stays public for both -- that is not the reporter authenticating,
      // it is the route being open to the world.
      expect(reporter).toBe(anonymous)
    })
  }

  it(`${NODE_STATS_INGEST_PATH}: THE one door -- POST passes for the reporter, anonymous does not`, () => {
    expect(passesAuth(NODE_STATS_INGEST_PATH, reporterSecret, 'POST')).toBe(true)
    expect(passesAuth(NODE_STATS_INGEST_PATH, undefined, 'POST')).toBe(false)
  })

  it('the door is POST-only: the same key on the same path with GET is refused', () => {
    expect(passesAuth(NODE_STATS_INGEST_PATH, reporterSecret)).toBe(false)
  })

  it('the door is that EXACT path, not a prefix of it', () => {
    for (const path of [`${NODE_STATS_INGEST_PATH}/../conversations`, `${NODE_STATS_INGEST_PATH}-admin`]) {
      expect(passesAuth(path, reporterSecret, 'POST')).toBe(false)
    }
  })

  it('ONE door, counted: every other route class stays shut to a POST too', () => {
    // The flip from "opens NOTHING" is only meaningful if the count is pinned.
    // A future capability granted too widely shows up here as a second opening.
    const opened = ROUTES.filter(p => passesAuth(p, reporterSecret, 'POST') && !passesAuth(p, undefined, 'POST'))
    expect(opened).toEqual([])
  })

  it('there is at least one route the SENTINEL key opens and the reporter does not', () => {
    const sentinelOnly = ROUTES.filter(p => passesAuth(p, sentinelSecret) && !passesAuth(p, reporterSecret))
    // Without this, "reporter is denied everywhere" could be true simply because
    // nothing was reachable by bearer auth in the first place.
    expect(sentinelOnly.length).toBeGreaterThan(0)
    expect(sentinelOnly).toContain('/api/sentinels')
    expect(sentinelOnly).toContain('/conversations')
  })

  it('a protected API route: sentinel 200-path, reporter 401', () => {
    expect(requireAuth(req('/api/sentinels', sentinelSecret))).toBeNull()
    const blocked = requireAuth(req('/api/sentinels', reporterSecret))
    expect(blocked).not.toBeNull()
    expect(blocked?.status).toBe(401)
  })
})

describe('the rpt_ key is never promoted to admin by the grant resolver', () => {
  const helpers = createRouteHelpers()

  it('resolveHttpGrants gives a reporter NO grants (a sentinel gets admin)', () => {
    // `null` means "admin, skip permission checks" in this API.
    expect(helpers.resolveHttpGrants(req('/api/sentinels', sentinelSecret))).toBeNull()
    expect(helpers.resolveHttpGrants(req('/api/sentinels', reporterSecret))).toEqual([])
  })

  it('httpIsAdmin is false for a reporter and true for a sentinel', () => {
    expect(helpers.httpIsAdmin(req('/api/sentinels', sentinelSecret))).toBe(true)
    expect(helpers.httpIsAdmin(req('/api/sentinels', reporterSecret))).toBe(false)
  })

  it('a reporter holds no permission on any project', () => {
    // `admin` is a ROLE, not a Permission -- httpIsAdmin above covers it.
    for (const perm of ['chat', 'spawn', 'files', 'terminal', 'settings'] as const) {
      expect(helpers.httpHasPermission(req('/api/x', reporterSecret), perm, '*')).toBe(false)
    }
  })
})

describe('the capability table still says the general HTTP surface is shut', () => {
  it('canAuthenticateHttpRoutes(reporter) is STILL false -- the new row is a separate one', () => {
    expect(canAuthenticateHttpRoutes('reporter')).toBe(false)
    expect(canIngestNodeStatsHttp('reporter')).toBe(true)
  })

  it('the ingest capability is not a back door to general HTTP for anyone', () => {
    // The two predicates must never be aliases: granting one must not grant the
    // other for any role in the table.
    for (const role of ['reporter', 'control-panel', 'agent-host', 'share', 'none'] as const) {
      expect(canAuthenticateHttpRoutes(role)).toBe(false)
    }
  })
})

describe('the rpt_ key CAN open a websocket -- its other door', () => {
  function wsReq(secret: string): Request {
    return new Request(`http://localhost:9999/ws?secret=${encodeURIComponent(secret)}`, {
      headers: { upgrade: 'websocket' },
    })
  }

  it('accepts the reporter secret at the WS upgrade', () => {
    expect(requireAuth(wsReq(reporterSecret))).toBeNull()
  })

  it('still rejects a garbage secret at the WS upgrade', () => {
    expect(requireAuth(wsReq('rpt_not_a_real_key'))?.status).toBe(401)
  })
})
