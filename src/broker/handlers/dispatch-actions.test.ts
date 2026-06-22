import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDispatchThreads, initDispatchThreads, upsertThread } from '../desk/threads'
import type { HandlerContext, MessageData, WsData } from '../handler-context'
import { routeMessage } from '../message-router'
import { registerDispatchHandlers } from './dispatch-actions'

beforeAll(() => {
  registerDispatchHandlers()
  initDispatchThreads(mkdtempSync(join(tmpdir(), 'dispatch-actions-test-')))
  upsertThread({ title: 'Broker perf sweep', summary: 'tracking the audit', now: Date.now() })
})

afterAll(() => {
  closeDispatchThreads()
})

function run(type: string, data: MessageData, wsData: Partial<WsData>): Record<string, unknown>[] {
  const replies: Record<string, unknown>[] = []
  const ctx = {
    ws: { data: wsData, send() {} },
    conversations: { getAllConversations: () => [] },
    reply: (m: Record<string, unknown>) => replies.push(m),
    requirePermission: () => {},
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  routeMessage(ctx, type, data)
  return replies
}

const CONTROL_PANEL: Partial<WsData> = { userName: 'jonas', isControlPanel: true }

describe('dispatch_list_threads handler', () => {
  it('returns the near-memory threads stamped with the authed user', () => {
    const replies = run('dispatch_list_threads', { requestId: 'r1' }, CONTROL_PANEL)
    expect(replies[0]).toMatchObject({ type: 'dispatch_threads_result', requestId: 'r1', userId: 'jonas' })
    const threads = replies[0].threads as Array<{ title: string }>
    expect(threads.some(t => t.title === 'Broker perf sweep')).toBe(true)
    // The live roster rides along so the overlay can show "active right now".
    expect(Array.isArray(replies[0].roster)).toBe(true)
  })

  it('is rejected for a non-control-panel caller (role gate, default-deny)', () => {
    const replies = run('dispatch_list_threads', { requestId: 'r2' }, {})
    expect(replies[0]).toMatchObject({ ok: false, requestId: 'r2' })
    expect(String(replies[0].error)).toContain('Forbidden')
  })
})

describe('dispatch_request handler', () => {
  it('rejects an empty intent before reaching the dispatcher', () => {
    const replies = run('dispatch_request', { intent: '   ', requestId: 'r3' }, CONTROL_PANEL)
    expect(replies[0]).toMatchObject({ type: 'dispatch_request_result', ok: false, requestId: 'r3' })
    expect(String(replies[0].error)).toContain('intent')
  })
})
