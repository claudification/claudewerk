/**
 * Nightshift WS handler -- the `run` (Run-now) intercept. The manual trigger is
 * executed IN the broker (it spawns the worker fleet via the orchestrator) and
 * must NOT be relayed to the sentinel like the artifact ops. These tests pin:
 * the run op calls `runNightshift` with the manual trigger, never touches the
 * sentinel socket, is files-permission gated, and surfaces a non-error skip
 * (e.g. empty queue) back to the caller -- while a normal op (config_read) still
 * relays. `runNightshift` is stubbed so no real agents spawn.
 *
 * Via `configureNightshiftRunner`, NOT `mock.module`: Bun's module mocks are
 * process-global and permanent, so a partial factory here silently deleted the
 * orchestrator's other exports for every later file in the run. See the seam's
 * comment in `nightshift-orchestrator.ts` and the guard in
 * `nightshift-orchestrator-no-module-mock.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { NightshiftOutlook } from '../../shared/protocol'
import { GuardError, type HandlerContext } from '../handler-context'
import { configureNightshiftRunner, resetNightshiftRunner } from '../nightshift-orchestrator'
import { nightshiftRequest } from './nightshift'
import { configureNightshiftOutlook, resetNightshiftOutlook } from './nightshift-outlook'

interface RunCall {
  project: string
  trigger: string
}
let runCalls: RunCall[] = []
let runOutcome: { ok: boolean; runId?: string; dispatched?: number; error?: string; skipped?: string } = {
  ok: true,
  runId: '2026-06-26',
  dispatched: 1,
}

// Installed per-test (not at module scope) so the stub is only live while THIS
// file's tests run -- the runner is a process-wide slot like any other seam.
function installStub(): void {
  configureNightshiftRunner(async (_store, project, opts) => {
    runCalls.push({ project, trigger: opts.trigger })
    return runOutcome
  })
}
afterAll(resetNightshiftRunner)

const PROJECT = 'claude://default/Users/jonas/projects/remote-claude'

function makeCtx(opts?: { denyPermission?: boolean }) {
  const replies: Record<string, unknown>[] = []
  const permCalls: Array<{ perm: string; project?: string }> = []
  const sentinelSends: string[] = []
  const sentinel = { send: (s: string) => sentinelSends.push(s) }
  const ctx = {
    ws: { data: { isControlPanel: true }, send: (s: string) => replies.push(JSON.parse(s)) },
    conversations: {
      getSentinel: () => sentinel,
      getSentinelByAlias: () => sentinel,
      addProjectListener() {},
      removeProjectListener() {},
    },
    getSentinel: () => sentinel,
    requirePermission: (perm: string, project?: string) => {
      permCalls.push({ perm, project })
      if (opts?.denyPermission) throw new GuardError('Forbidden')
    },
    broadcastScoped() {},
    reply() {},
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  return { ctx, replies, permCalls, sentinelSends }
}

beforeEach(() => {
  runCalls = []
  runOutcome = { ok: true, runId: '2026-06-26', dispatched: 1 }
  installStub()
})

describe('nightshift run-now intercept', () => {
  test('op=run drains via runNightshift with the manual trigger and never relays to the sentinel', async () => {
    const { ctx, replies, sentinelSends } = makeCtx()
    await nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'r1', project: PROJECT, op: 'run' })

    expect(runCalls).toEqual([{ project: PROJECT, trigger: 'manual' }])
    // The whole point: a Run-now is handled in the broker, NOT forwarded to the
    // sentinel artifact writer.
    expect(sentinelSends).toHaveLength(0)
    expect(replies[0]).toMatchObject({
      type: 'nightshift_result',
      requestId: 'r1',
      op: 'run',
      ok: true,
    })
  })

  test('op=run is files-permission gated -- denial throws and never spawns', async () => {
    const { ctx, sentinelSends } = makeCtx({ denyPermission: true })
    await expect(
      nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'r2', project: PROJECT, op: 'run' }),
    ).rejects.toThrow(GuardError)

    expect(runCalls).toHaveLength(0)
    expect(sentinelSends).toHaveLength(0)
  })

  test('op=run requires the write-level files permission', async () => {
    const { ctx, permCalls } = makeCtx()
    await nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'r3', project: PROJECT, op: 'run' })
    expect(permCalls[0]).toEqual({ perm: 'files', project: PROJECT })
  })

  test('a non-error skip (empty queue) is surfaced as ok=false with the reason', async () => {
    runOutcome = { ok: false, skipped: 'queue is empty' }
    const { ctx, replies } = makeCtx()
    await nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'r4', project: PROJECT, op: 'run' })
    expect(replies[0]).toMatchObject({ op: 'run', ok: false, error: 'queue is empty' })
  })

  test('a normal artifact op (config_read) still relays to the sentinel (only run/outlook intercept)', async () => {
    const { ctx, sentinelSends } = makeCtx()
    await nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'r5', project: PROJECT, op: 'config_read' })
    expect(runCalls).toHaveLength(0)
    expect(sentinelSends).toHaveLength(1)
    expect(JSON.parse(sentinelSends[0])).toMatchObject({ type: 'nightshift_op', op: 'config_read' })
  })
})

/**
 * The OUTLOOK intercept. Same shape as Run-now and for the same reason -- the
 * scan needs the conversation registry, which only the broker has -- except it
 * is a READ: nothing dispatches, so it must never demand the write permission.
 */
describe('nightshift outlook intercept', () => {
  const OUTLOOK: NightshiftOutlook = {
    admitted: [],
    refused: [{ unit: 'c', bucket: 'over-cap', detail: 'run opens with at most 2 task(s)' }],
    selected: ['c'],
    buckets: ['closed-lane', 'live-conversation', 'unreadable', 'over-cap'],
    totalTasks: 2,
  }
  let outlookCalls: string[] = []

  beforeEach(() => {
    outlookCalls = []
    configureNightshiftOutlook(async (_store, project) => {
      outlookCalls.push(project)
      return OUTLOOK
    })
  })
  afterAll(resetNightshiftOutlook)

  test('op=outlook answers from the broker scan and never relays to the sentinel', async () => {
    const { ctx, replies, sentinelSends } = makeCtx()
    await nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'o1', project: PROJECT, op: 'outlook' })

    expect(outlookCalls).toEqual([PROJECT])
    expect(sentinelSends).toHaveLength(0)
    expect(replies[0]).toMatchObject({ type: 'nightshift_result', requestId: 'o1', op: 'outlook', ok: true })
    // The refusals ride the reply -- the pane cannot be honest without them.
    expect((replies[0] as { outlook: NightshiftOutlook }).outlook.refused).toHaveLength(1)
  })

  test('op=outlook is a READ -- files:read, not the write permission', async () => {
    const { ctx, permCalls } = makeCtx()
    await nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'o2', project: PROJECT, op: 'outlook' })
    expect(permCalls[0]).toEqual({ perm: 'files:read', project: PROJECT })
  })

  test('a scan that blows up still replies -- a dropped reply leaves the pane spinning', async () => {
    configureNightshiftOutlook(async () => {
      throw new Error('store is gone')
    })
    const { ctx, replies } = makeCtx()
    await nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'o3', project: PROJECT, op: 'outlook' })
    expect(replies[0]).toMatchObject({ op: 'outlook', ok: false, error: 'store is gone' })
  })

  test('op=outlook never fires a run', async () => {
    const { ctx } = makeCtx()
    await nightshiftRequest(ctx, { type: 'nightshift_request', requestId: 'o4', project: PROJECT, op: 'outlook' })
    expect(runCalls).toHaveLength(0)
  })
})
