/**
 * THE GATE on the agent-facing schedule surface.
 *
 * A schedule is a spawn that fires with nobody watching, so these tests pin the
 * two properties that make the agent surface narrower than the panel's:
 * an untrusted conversation cannot ARM one at all, and it cannot look at what
 * other projects have armed. Everything else about a schedule is enforced by
 * the shared schema; only the trust boundary is new here, so only it is tested.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { HandlerContext } from '../handler-context'
import { createScheduleHandlers } from './scheduled-tasks-mcp'

// Injected, never `mock.module`d: that mock is process-global and would break
// every sibling suite that imports the real auth store in the same run.
const scheduleHandlers = createScheduleHandlers({
  resolveOwner: explicit =>
    explicit === 'nobody'
      ? { ok: false, error: 'owner "nobody" is not a registered user' }
      : { ok: true, userName: explicit ?? 'jonas' },
  getEngine: () => ({ runNow: async () => ({ ok: true }) }),
})

const OWN = 'claude://default/Users/jonas/projects/foo'
const OTHER = 'claude://default/Users/jonas/projects/bar'

function schedule(over: Record<string, unknown> = {}) {
  return {
    id: 'sch_aaaa',
    name: 'nightly',
    enabled: true,
    projectUri: OWN,
    cwd: '/Users/jonas/projects/foo',
    cron: '0 9 * * 1-5',
    tz: 'Europe/Berlin',
    catchUp: 'skip',
    overlap: 'skip',
    prompt: 'do the thing',
    spawn: { adHoc: true, leaveRunning: false, headless: true, transport: 'claude-headless' },
    createdBy: 'jonas',
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    consecutiveFailures: 0,
    ...over,
  }
}

let stored: Record<string, unknown>[] = []

function makeCtx(trustLevel?: string) {
  const replies: Record<string, unknown>[] = []
  const ctx = {
    ws: { data: { conversationId: 'conv_1', isAgentHost: true } },
    callerSettings: trustLevel ? { trustLevel } : null,
    caller: { project: OWN },
    conversations: {
      getConversation: () => ({ project: OWN }),
      getSubscribers: () => new Set(),
    },
    store: {
      scheduledTasks: {
        list: (filter?: { projectUri?: string }) =>
          [schedule(), schedule({ id: 'sch_bbbb', projectUri: OTHER })].filter(
            s => !filter?.projectUri || s.projectUri === filter.projectUri,
          ),
        get: (id: string) =>
          id === 'sch_bbbb' ? schedule({ id: 'sch_bbbb', projectUri: OTHER }) : id === 'sch_aaaa' ? schedule() : null,
        upsert: (t: Record<string, unknown>) => stored.push(t),
        delete: () => {},
        listRuns: () => [],
      },
    },
    reply: (m: Record<string, unknown>) => replies.push(m),
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  return { ctx, replies }
}

const createBody = {
  name: 'nightly',
  prompt: 'do it',
  projectUri: OWN,
  cwd: '/Users/jonas/projects/foo',
  cron: '0 9 * * 1-5',
  tz: 'Europe/Berlin',
  spawn: { adHoc: true, leaveRunning: false, headless: true, transport: 'claude-headless' },
}

beforeEach(() => {
  stored = []
})

describe('writes require benevolent trust', () => {
  const WRITES = [
    ['schedule_create_request', { schedule: createBody }],
    ['schedule_update_request', { id: 'sch_aaaa', patch: { enabled: false } }],
    ['schedule_delete_request', { id: 'sch_aaaa' }],
    ['schedule_run_now_request', { id: 'sch_aaaa' }],
  ] as const

  for (const [type, data] of WRITES) {
    test(`${type} is refused for an untrusted conversation`, () => {
      const { ctx, replies } = makeCtx('default')
      scheduleHandlers[type](ctx, { ...data, requestId: 'r1' } as never)
      expect(replies[0].ok).toBe(false)
      expect(String(replies[0].error)).toContain('benevolent')
    })
  }

  test('nothing was written while refused', () => {
    const { ctx } = makeCtx('default')
    scheduleHandlers.schedule_create_request(ctx, { schedule: createBody, requestId: 'r' } as never)
    expect(stored).toHaveLength(0)
  })

  test('a benevolent conversation may arm one', () => {
    const { ctx, replies } = makeCtx('benevolent')
    scheduleHandlers.schedule_create_request(ctx, { schedule: createBody, requestId: 'r' } as never)
    expect(replies[0].ok).toBe(true)
    expect(stored).toHaveLength(1)
  })

  test('the owner is the resolved USER, never the conversation', () => {
    const { ctx } = makeCtx('benevolent')
    scheduleHandlers.schedule_create_request(ctx, { schedule: createBody, requestId: 'r' } as never)
    expect(stored[0].createdBy).toBe('jonas')
  })

  test('an unresolvable owner refuses the create instead of arming a dud', () => {
    const { ctx, replies } = makeCtx('benevolent')
    scheduleHandlers.schedule_create_request(ctx, {
      schedule: createBody,
      owner: 'nobody',
      requestId: 'r',
    } as never)
    expect(replies[0].ok).toBe(false)
    expect(stored).toHaveLength(0)
  })
})

describe('reads are scoped to the caller own project', () => {
  test('an untrusted conversation sees only its own project', () => {
    const { ctx, replies } = makeCtx('default')
    scheduleHandlers.schedule_list_request(ctx, { requestId: 'r' } as never)
    const schedules = replies[0].schedules as Array<{ projectUri: string }>
    expect(schedules).toHaveLength(1)
    expect(schedules[0].projectUri).toBe(OWN)
  })

  test('asking for ANOTHER project is refused, not silently narrowed', () => {
    const { ctx, replies } = makeCtx('default')
    scheduleHandlers.schedule_list_request(ctx, { projectUri: OTHER, requestId: 'r' } as never)
    expect(replies[0].ok).toBe(false)
    expect(String(replies[0].error)).toContain('benevolent')
  })

  test('a benevolent conversation sees every project', () => {
    const { ctx, replies } = makeCtx('benevolent')
    scheduleHandlers.schedule_list_request(ctx, { requestId: 'r' } as never)
    expect(replies[0].schedules as unknown[]).toHaveLength(2)
  })

  test('schedule_get cannot reach a schedule in another project', () => {
    const { ctx, replies } = makeCtx('default')
    scheduleHandlers.schedule_get_request(ctx, { id: 'sch_bbbb', requestId: 'r' } as never)
    expect(replies[0].ok).toBe(false)
    expect(String(replies[0].error)).toContain('another project')
  })

  test('schedule_get returns the caller own schedule with its history', () => {
    const { ctx, replies } = makeCtx('default')
    scheduleHandlers.schedule_get_request(ctx, { id: 'sch_aaaa', requestId: 'r' } as never)
    expect(replies[0].ok).toBe(true)
    expect(replies[0].runs).toEqual([])
  })
})

test('every reply echoes the requestId, so a caller never hangs to a timeout', () => {
  const { ctx, replies } = makeCtx('default')
  scheduleHandlers.schedule_delete_request(ctx, { id: 'sch_aaaa', requestId: 'req-42' } as never)
  expect(replies[0].requestId).toBe('req-42')
  expect(replies[0].type).toBe('schedule_result')
})
