/**
 * The `schedule_*` tool surface.
 *
 * The gate itself is broker-side and tested there. What matters HERE is what
 * the tool puts on the wire, because two of those defaults are silent when
 * wrong and only discovered at 03:00: the TIMEZONE (the broker is UTC, so an
 * unzoned schedule fires at the wrong hour) and the DIRECTORY (a worktree path
 * outlives nothing -- the worktree is deleted and the schedule fires into a
 * directory that is gone).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenDialogRegistry } from '../open-dialogs'
import { _resetBrokerRpc, dispatchBrokerRpcResponse, setBrokerRpcSender } from './lib/broker-rpc'
import { registerScheduleTools } from './schedule'
import type { AgentHostIdentity, McpToolContext, ToolDef } from './types'

function buildCtx(cwd: string | null): McpToolContext {
  const identity: AgentHostIdentity | null = cwd
    ? { ccSessionId: 'cc_x', conversationId: 'conv_x', cwd, headless: true }
    : null
  return {
    callbacks: {},
    getIdentity: () => identity,
    getClaudeCodeVersion: () => '0.0.0',
    getDialogCwd: () => '/tmp',
    pendingDialogs: new Map(),
    openDialogs: new OpenDialogRegistry(),
    elog: () => {},
  }
}

const REPO = '/Users/jonas/projects/foo'
const tools = (cwd: string | null = REPO) => registerScheduleTools(buildCtx(cwd))

const SCHEDULE = {
  id: 'sch_aaaa',
  name: 'nightly',
  enabled: true,
  projectUri: `claude://default${REPO}`,
  cwd: REPO,
  cron: '0 9 * * 1-5',
  tz: 'Europe/Berlin',
  catchUp: 'skip',
  overlap: 'skip',
  prompt: 'do it',
  spawn: {},
  createdBy: 'jonas',
  createdAt: 0,
  updatedAt: 0,
  runCount: 3,
  consecutiveFailures: 0,
}

async function call(tool: ToolDef, params: Record<string, unknown>, reply: Record<string, unknown> = { ok: true }) {
  const sent: Record<string, unknown>[] = []
  setBrokerRpcSender(msg => {
    const m = msg as unknown as Record<string, unknown>
    sent.push(m)
    queueMicrotask(() => dispatchBrokerRpcResponse({ requestId: m.requestId, ...reply }))
  })
  const result = await tool.handle(params as Record<string, string>, { rawArgs: params, extra: {} })
  return { result, sent, body: sent[0] }
}

beforeEach(() => _resetBrokerRpc())
afterEach(() => _resetBrokerRpc())

test('exposes full CRUD plus run-now', () => {
  expect(Object.keys(tools()).sort()).toEqual([
    'schedule_create',
    'schedule_delete',
    'schedule_get',
    'schedule_list',
    'schedule_run_now',
    'schedule_update',
  ])
})

describe('schedule_create defaults', () => {
  test('defaults the timezone to THIS HOST, never the UTC broker', async () => {
    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const { body } = await call(tools().schedule_create, { name: 'n', prompt: 'p', cron: '0 9 * * *' })
    expect((body.schedule as { tz: string }).tz).toBe(hostZone)
  })

  test('an explicit timezone wins', async () => {
    const { body } = await call(tools().schedule_create, {
      name: 'n',
      prompt: 'p',
      cron: '0 9 * * *',
      tz: 'Asia/Tokyo',
    })
    expect((body.schedule as { tz: string }).tz).toBe('Asia/Tokyo')
  })

  test('a worktree cwd is folded back to the repo root', async () => {
    const wt = `${REPO}/.claude/worktrees/some-branch`
    const { body } = await call(tools(wt).schedule_create, { name: 'n', prompt: 'p', cron: '0 9 * * *' })
    const sched = body.schedule as { cwd: string; projectUri: string }
    expect(sched.cwd).toBe(REPO)
    expect(sched.projectUri).not.toContain('worktrees')
  })

  test('refuses cron AND runAt -- they are different kinds of schedule', async () => {
    const { result } = await call(tools().schedule_create, {
      name: 'n',
      prompt: 'p',
      cron: '0 9 * * *',
      runAt: Date.now() + 60_000,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('never both')
  })

  test('refuses neither cron nor runAt rather than arming something inert', async () => {
    const { result } = await call(tools().schedule_create, { name: 'n', prompt: 'p' })
    expect(result.isError).toBe(true)
  })

  test('says so when the host reports no cwd to derive from', async () => {
    const { result } = await call(tools(null).schedule_create, { name: 'n', prompt: 'p', cron: '0 9 * * *' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('cwd')
  })
})

describe('schedule_update', () => {
  test('sends ONLY the fields supplied, so omitted ones are left alone', async () => {
    const { body } = await call(
      tools().schedule_update,
      { id: 'sch_aaaa', enabled: false },
      { ok: true, schedule: { ...SCHEDULE, enabled: false } },
    )
    expect(body.patch).toEqual({ enabled: false })
  })

  test('enabled is a real boolean on the wire, not the string "false"', async () => {
    const { body } = await call(
      tools().schedule_update,
      { id: 'sch_aaaa', enabled: 'false' },
      { ok: true, schedule: { ...SCHEDULE, enabled: false } },
    )
    expect((body.patch as { enabled: unknown }).enabled).toBe(false)
  })

  test('an empty patch is refused instead of a pointless round trip', async () => {
    const { result } = await call(tools().schedule_update, { id: 'sch_aaaa' })
    expect(result.isError).toBe(true)
  })
})

describe('what the agent reads back', () => {
  test('a created schedule reports its zone AND its next fire', async () => {
    const { result } = await call(
      tools().schedule_create,
      { name: 'n', prompt: 'p', cron: '0 9 * * *' },
      { ok: true, schedule: SCHEDULE },
    )
    expect(result.content[0].text).toContain('Europe/Berlin')
    expect(result.content[0].text).toContain('next run')
  })

  test('a disabled schedule says so rather than showing a fire that will not happen', async () => {
    const { result } = await call(
      tools().schedule_get,
      { id: 'sch_aaaa' },
      { ok: true, schedule: { ...SCHEDULE, enabled: false }, runs: [] },
    )
    expect(result.content[0].text).toContain('DISABLED')
    expect(result.content[0].text).toContain('(disabled)')
  })

  test('history shows the fires that launched NOTHING', async () => {
    const { result } = await call(
      tools().schedule_get,
      { id: 'sch_aaaa' },
      {
        ok: true,
        schedule: SCHEDULE,
        runs: [
          { id: 'r1', scheduleId: 'sch_aaaa', firedAt: Date.now(), minuteKey: 'k', trigger: 'cron', outcome: 'missed' },
        ],
      },
    )
    expect(result.content[0].text).toContain('missed')
  })

  test('an empty list points at how to make one', async () => {
    const { result } = await call(tools().schedule_list, {}, { ok: true, schedules: [] })
    expect(result.content[0].text).toContain('schedule_create')
  })

  test('a broker refusal surfaces as a tool error, not a silent success', async () => {
    const { result } = await call(
      tools().schedule_delete,
      { id: 'sch_aaaa' },
      { ok: false, error: 'Deleting a schedule requires benevolent trust level' },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('benevolent')
  })
})
