import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { HandlerContext, MessageData, WsData } from '../../handler-context'
import { routeMessage } from '../../message-router'
import { resetRecapOrchestratorForTests } from '../../recap-orchestrator'
import { registerRecapHandlers } from '../recap'

// Pillar B: benevolent agent-host conversations may trigger recap_create (the
// eval harness), and EVERY router rejection echoes requestId so the MCP/brokerRpc
// caller surfaces the error instead of hanging to a 30s silent timeout.

beforeAll(() => {
  registerRecapHandlers()
})

// These tests prove the role + benevolent trust gates by checking what a caller
// lands on AFTER clearing them: with the orchestrator uninitialised, the next
// step is a synchronous 'recap orchestrator not initialised' recap_error. The
// orchestrator is a process-global singleton, so a sibling test file that calls
// initRecapOrchestrator() (e.g. routes/recaps.test.ts) leaks it into this run and
// makes recap_create dispatch ASYNC (no synchronous reply). Reset it before each
// test so this file owns its precondition regardless of execution order.
beforeEach(() => {
  resetRecapOrchestratorForTests()
})

function settings(trustLevel: 'default' | 'open' | 'benevolent'): HandlerContext['callerSettings'] {
  return { trustLevel } as unknown as HandlerContext['callerSettings']
}

function run(
  type: string,
  data: MessageData,
  wsData: Partial<WsData>,
  callerSettings?: HandlerContext['callerSettings'],
): Record<string, unknown>[] {
  const replies: Record<string, unknown>[] = []
  const ctx = {
    ws: { data: wsData },
    callerSettings: callerSettings ?? null,
    reply: (m: Record<string, unknown>) => replies.push(m),
    requirePermission: () => {},
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  routeMessage(ctx, type, data)
  return replies
}

describe('router requestId echo on rejections', () => {
  it('echoes requestId when a role-gated handler rejects the caller', () => {
    // recap_cancel is dashboard-only; an agent-host caller (default role for {})
    // is role-rejected. The reply must carry requestId.
    const replies = run('recap_cancel', { requestId: 'req-1', recapId: 'recap_x' }, {})
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({ type: 'recap_cancel_result', ok: false, requestId: 'req-1' })
    expect(String(replies[0].error)).toContain('Forbidden')
  })

  it('omits requestId when the caller sent none (no bogus undefined field)', () => {
    const replies = run('recap_cancel', { recapId: 'recap_x' }, {})
    expect(replies[0].ok).toBe(false)
    expect('requestId' in replies[0]).toBe(false)
  })
})

describe('recap_create role + benevolent trust gate', () => {
  it('rejects a non-benevolent agent-host with a clean error + requestId', () => {
    const replies = run(
      'recap_create',
      { requestId: 'req-2', projectUri: 'claude://h/p', timeZone: 'UTC', period: { label: 'last_7' } },
      {},
      settings('default'),
    )
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      type: 'recap_error',
      error: 'Requires benevolent trust level',
      requestId: 'req-2',
    })
  })

  it('lets a benevolent agent-host past the trust gate', () => {
    // The orchestrator is not initialised in unit tests, so a caller that passes
    // BOTH gates lands on the next error -- proving it cleared role + benevolent.
    const replies = run(
      'recap_create',
      { requestId: 'req-3', projectUri: 'claude://h/p', timeZone: 'UTC', period: { label: 'last_7' } },
      {},
      settings('benevolent'),
    )
    expect(replies[0]).toMatchObject({ type: 'recap_error', requestId: 'req-3' })
    expect(replies[0].error).not.toBe('Requires benevolent trust level')
  })

  it('lets a dashboard (control-panel) caller past regardless of trust level', () => {
    const replies = run(
      'recap_create',
      { requestId: 'req-4', projectUri: 'claude://h/p', timeZone: 'UTC', period: { label: 'last_7' } },
      { userName: 'jonas' },
      settings('default'),
    )
    expect(replies[0]).toMatchObject({ type: 'recap_error', requestId: 'req-4' })
    expect(replies[0].error).not.toBe('Requires benevolent trust level')
  })
})
