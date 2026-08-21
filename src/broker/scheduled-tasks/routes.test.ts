/**
 * Route tests for /api/scheduled-tasks.
 *
 * Two things matter most here and both are security-shaped: nothing works
 * without the `spawn` permission (a schedule IS a spawn), and a schedule that
 * cannot be evaluated -- bad cron, bogus zone -- is refused at the door rather
 * than stored to fail silently at 03:00.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { DEFAULT_SCHEDULE_SPAWN } from '../../shared/scheduled-task'
import { createAuthToken, createUser, initAuth, setUserGrants } from '../auth'
import { type ConversationStore, createConversationStore } from '../conversation-store'
import { createRouteHelpers } from '../routes/shared'
import { createMemoryDriver } from '../store/memory/driver'
import type { StoreDriver } from '../store/types'
import type { ScheduledTaskEngine } from './engine'
import { createScheduledTasksRouter } from './routes'

const COOKIE_NAME = 'cw-session'

let app: Hono
let store: StoreDriver
let conversationStore: ConversationStore
let ADMIN: string
let NO_SPAWN: string
let counter = 0
let engine: ScheduledTaskEngine | null
let runNowCalls: string[]

function asUser(name: string): { Cookie: string } {
  return { Cookie: `${COOKIE_NAME}=${createAuthToken(name)}` }
}

const VALID = {
  name: 'nightly audit',
  projectUri: 'claude:///Users/jonas/projects/remote-claude',
  cwd: '/Users/jonas/projects/remote-claude',
  cron: '0 9 * * 1-5',
  tz: 'Europe/Berlin',
  prompt: 'Audit the repo and report.',
  spawn: DEFAULT_SCHEDULE_SPAWN,
}

async function create(body: unknown = VALID, user = ADMIN) {
  return app.request('/api/scheduled-tasks', {
    method: 'POST',
    headers: { ...asUser(user), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  initAuth({ cacheDir: mkdtempSync(join(tmpdir(), 'sched-routes-test-')), skipTimers: true })
  counter++
  ADMIN = `admin-${counter}`
  NO_SPAWN = `viewer-${counter}`
  createUser(ADMIN)
  createUser(NO_SPAWN)
  // A user with project access but explicitly WITHOUT spawn.
  setUserGrants(NO_SPAWN, [{ scope: '*', permissions: ['chat:read'] }])

  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })

  runNowCalls = []
  engine = {
    stop: () => {},
    tick: async () => {},
    runNow: async (id: string) => {
      runNowCalls.push(id)
      return { ok: true }
    },
  }

  app = new Hono()
  app.route(
    '/',
    createScheduledTasksRouter({
      store,
      conversationStore,
      helpers: createRouteHelpers(),
      getEngine: () => engine,
    }),
  )
})

describe('auth', () => {
  it('401s without a session', async () => {
    expect((await app.request('/api/scheduled-tasks')).status).toBe(401)
  })

  it('403s a user without the spawn permission -- a schedule IS a spawn', async () => {
    const res = await app.request('/api/scheduled-tasks', { headers: asUser(NO_SPAWN) })
    expect(res.status).toBe(403)
  })

  it('403s creation without the spawn permission', async () => {
    expect((await create(VALID, NO_SPAWN)).status).toBe(403)
  })
})

describe('POST /api/scheduled-tasks', () => {
  it('creates a schedule and stamps the server-owned fields', async () => {
    const res = await create()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scheduledTask: Record<string, unknown> }
    expect(body.scheduledTask.id).toMatch(/^sch_/)
    expect(body.scheduledTask.createdBy).toBe(ADMIN)
    expect(body.scheduledTask.runCount).toBe(0)
    expect(body.scheduledTask.enabled).toBe(true)
  })

  it('rejects an unparseable cron rather than storing a schedule that never fires', async () => {
    const res = await create({ ...VALID, cron: '99 * * * *' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('cron')
  })

  it('rejects a bogus timezone', async () => {
    const res = await create({ ...VALID, tz: 'Mars/Olympus' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('IANA')
  })

  it('rejects a schedule with no prompt', async () => {
    expect((await create({ ...VALID, prompt: '' })).status).toBe(400)
  })

  it('rejects malformed JSON', async () => {
    const res = await app.request('/api/scheduled-tasks', {
      method: 'POST',
      headers: { ...asUser(ADMIN), 'Content-Type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/scheduled-tasks', () => {
  it('lists what was created', async () => {
    await create()
    const res = await app.request('/api/scheduled-tasks', { headers: asUser(ADMIN) })
    const body = (await res.json()) as { scheduledTasks: unknown[] }
    expect(body.scheduledTasks).toHaveLength(1)
  })

  it('filters by project', async () => {
    await create()
    await create({ ...VALID, projectUri: 'claude:///other', cwd: '/other' })
    const res = await app.request('/api/scheduled-tasks?project=claude:///other', { headers: asUser(ADMIN) })
    const body = (await res.json()) as { scheduledTasks: Array<{ projectUri: string }> }
    expect(body.scheduledTasks).toHaveLength(1)
    expect(body.scheduledTasks[0]?.projectUri).toBe('claude:///other')
  })
})

describe('PATCH /api/scheduled-tasks/:id', () => {
  async function created() {
    const res = await create()
    return ((await res.json()) as { scheduledTask: { id: string } }).scheduledTask.id
  }

  it('toggles enabled', async () => {
    const id = await created()
    const res = await app.request(`/api/scheduled-tasks/${id}`, {
      method: 'PATCH',
      headers: { ...asUser(ADMIN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    expect(store.scheduledTasks.get(id)?.enabled).toBe(false)
  })

  it('re-arming clears a stale failure count', async () => {
    const id = await created()
    const task = store.scheduledTasks.get(id)
    if (!task) throw new Error('missing')
    store.scheduledTasks.upsert({ ...task, enabled: false, consecutiveFailures: 5 })

    await app.request(`/api/scheduled-tasks/${id}`, {
      method: 'PATCH',
      headers: { ...asUser(ADMIN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    expect(store.scheduledTasks.get(id)?.consecutiveFailures).toBe(0)
  })

  it('re-validates the merged record, not just the patch', async () => {
    const id = await created()
    const task = store.scheduledTasks.get(id)
    if (!task) throw new Error('missing')
    store.scheduledTasks.upsert({ ...task, startAt: 5000 })

    // endAt alone is a valid patch, but produces an inverted window.
    const res = await app.request(`/api/scheduled-tasks/${id}`, {
      method: 'PATCH',
      headers: { ...asUser(ADMIN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ endAt: 1000 }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a bad cron on patch', async () => {
    const id = await created()
    const res = await app.request(`/api/scheduled-tasks/${id}`, {
      method: 'PATCH',
      headers: { ...asUser(ADMIN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('404s an unknown id', async () => {
    const res = await app.request('/api/scheduled-tasks/sch_nope', {
      method: 'PATCH',
      headers: { ...asUser(ADMIN), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(404)
  })
})

/**
 * AN `epic-start` SCHEDULE, through the write path both callers share.
 *
 * The interesting rules are cross-field ones a plain object schema cannot say:
 * an arm needs an epic and no prompt, a spawn needs a prompt and no epic, and
 * editing one knob of an armed schedule must not require re-sending the epic id
 * beside it -- the exact contract `epic_run action=start` already promises.
 */
describe('epic-start schedules', () => {
  const EPIC = {
    ...VALID,
    prompt: undefined,
    action: 'epic-start',
    epic: { epicId: 'epic-the-wall', when: 'window,queue', maxUsd: 40 },
  }

  async function patch(id: string, body: unknown) {
    return app.request(`/api/scheduled-tasks/${id}`, {
      method: 'PATCH',
      headers: { ...asUser(ADMIN), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function createEpic() {
    const res = await create(EPIC)
    expect(res.status).toBe(200)
    return ((await res.json()) as { scheduledTask: { id: string } }).scheduledTask.id
  }

  it('stores the arm payload verbatim, with no prompt to invent', async () => {
    const stored = store.scheduledTasks.get(await createEpic())
    expect(stored?.action).toBe('epic-start')
    expect(stored?.epic).toEqual({ epicId: 'epic-the-wall', when: 'window,queue', maxUsd: 40 })
    expect(stored?.prompt).toBeUndefined()
  })

  it('refuses an arm that names no epic rather than arming nothing every Saturday', async () => {
    const res = await create({ ...EPIC, epic: undefined })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('epic is required')
  })

  it('refuses an epic block on a spawn -- that is somebody who forgot the action', async () => {
    const res = await create({ ...VALID, epic: { epicId: 'epic-the-wall' } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('epic-start')
  })

  it('raising one ceiling keeps every other knob, the epic id included', async () => {
    const id = await createEpic()
    expect((await patch(id, { epic: { maxUsd: 200 } })).status).toBe(200)

    expect(store.scheduledTasks.get(id)?.epic).toEqual({
      epicId: 'epic-the-wall',
      when: 'window,queue',
      maxUsd: 200,
    })
  })

  it('turning it back into a spawn clears the epic block instead of deadlocking', async () => {
    const id = await createEpic()
    // Both halves in one patch: the action changes AND the prompt arrives. A
    // merge that kept the stale epic block would refuse this forever.
    expect((await patch(id, { action: 'spawn', prompt: 'do it by hand' })).status).toBe(200)

    const stored = store.scheduledTasks.get(id)
    expect(stored?.action).toBe('spawn')
    expect(stored?.epic).toBeUndefined()
  })
})

describe('DELETE /api/scheduled-tasks/:id', () => {
  it('removes the schedule', async () => {
    const res = await create()
    const id = ((await res.json()) as { scheduledTask: { id: string } }).scheduledTask.id
    const del = await app.request(`/api/scheduled-tasks/${id}`, { method: 'DELETE', headers: asUser(ADMIN) })
    expect(del.status).toBe(200)
    expect(store.scheduledTasks.get(id)).toBeNull()
  })

  it('404s an unknown id', async () => {
    const res = await app.request('/api/scheduled-tasks/sch_nope', { method: 'DELETE', headers: asUser(ADMIN) })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/scheduled-tasks/:id/run', () => {
  async function created() {
    const res = await create()
    return ((await res.json()) as { scheduledTask: { id: string } }).scheduledTask.id
  }

  it('asks the engine to fire now', async () => {
    const id = await created()
    const res = await app.request(`/api/scheduled-tasks/${id}/run`, { method: 'POST', headers: asUser(ADMIN) })
    expect(res.status).toBe(200)
    expect(runNowCalls).toEqual([id])
  })

  it('503s when the scheduler is not running', async () => {
    const id = await created()
    engine = null
    const res = await app.request(`/api/scheduled-tasks/${id}/run`, { method: 'POST', headers: asUser(ADMIN) })
    expect(res.status).toBe(503)
  })

  it('403s without the spawn permission', async () => {
    const id = await created()
    const res = await app.request(`/api/scheduled-tasks/${id}/run`, { method: 'POST', headers: asUser(NO_SPAWN) })
    expect(res.status).toBe(403)
    expect(runNowCalls).toEqual([])
  })
})

describe('GET /api/scheduled-tasks/:id/runs', () => {
  it('returns the history newest first', async () => {
    const res = await create()
    const id = ((await res.json()) as { scheduledTask: { id: string } }).scheduledTask.id
    store.scheduledTasks.addRun({
      id: 'schrun_a',
      scheduleId: id,
      firedAt: 1000,
      minuteKey: 'k',
      trigger: 'cron',
      outcome: 'spawned',
    })
    store.scheduledTasks.addRun({
      id: 'schrun_b',
      scheduleId: id,
      firedAt: 2000,
      minuteKey: 'k',
      trigger: 'manual',
      outcome: 'error',
    })

    const got = await app.request(`/api/scheduled-tasks/${id}/runs`, { headers: asUser(ADMIN) })
    const body = (await got.json()) as { runs: Array<{ id: string }> }
    expect(body.runs.map(r => r.id)).toEqual(['schrun_b', 'schrun_a'])
  })

  it('404s an unknown id', async () => {
    const res = await app.request('/api/scheduled-tasks/sch_nope/runs', { headers: asUser(ADMIN) })
    expect(res.status).toBe(404)
  })
})
