import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { HandlerContext, MessageData, WsData } from '../../handler-context'
import { routeMessage } from '../../message-router'
import { __resetWebControlForTests, listWebControlClients } from '../../web-control'
import { registerWebControlHandlers } from '../web-control'

beforeAll(() => {
  registerWebControlHandlers()
})

afterEach(() => {
  __resetWebControlForTests()
})

function run(type: string, data: MessageData, wsData: Partial<WsData>): Record<string, unknown>[] {
  const replies: Record<string, unknown>[] = []
  const ctx = {
    ws: { data: wsData, send() {} },
    reply: (m: Record<string, unknown>) => replies.push(m),
    requirePermission: () => {},
    log: { info() {}, error() {}, debug() {} },
  } as unknown as HandlerContext
  routeMessage(ctx, type, data)
  return replies
}

const CONTROL_PANEL: Partial<WsData> = { userName: 'jonas', userAgent: 'TestBrowser/1.0', isControlPanel: true }
const ADVERTISE: MessageData = {
  clientId: 'web_h1',
  grantId: 'g1',
  expiresAt: Date.now() + 60_000,
  capabilities: ['screenshot', 'list_commands'],
  label: 'Mac / Chrome',
}

describe('web_control_advertise handler', () => {
  it('registers an opted-in browser for a control-panel caller', () => {
    const replies = run('web_control_advertise', { ...ADVERTISE }, CONTROL_PANEL)
    expect(replies[0]).toMatchObject({ type: 'web_control_advertise_ack', ok: true, clientId: 'web_h1' })
    expect(listWebControlClients().map(c => c.clientId)).toContain('web_h1')
  })

  it('rejects an agent-host caller via the router role gate (default-deny by role)', () => {
    const replies = run('web_control_advertise', { ...ADVERTISE, requestId: 'r1' }, {})
    expect(replies[0]).toMatchObject({ type: 'web_control_advertise_result', ok: false, requestId: 'r1' })
    expect(String(replies[0].error)).toContain('Forbidden')
    expect(listWebControlClients()).toHaveLength(0)
  })

  it('rejects an advertise with no capabilities', () => {
    const replies = run('web_control_advertise', { ...ADVERTISE, capabilities: [] }, CONTROL_PANEL)
    expect(replies[0]).toMatchObject({ type: 'web_control_advertise_ack', ok: false })
    expect(listWebControlClients()).toHaveLength(0)
  })

  it('drops unknown capability strings but keeps valid ones', () => {
    run('web_control_advertise', { ...ADVERTISE, capabilities: ['screenshot', 'rm_rf', 'send_prompt'] }, CONTROL_PANEL)
    const [c] = listWebControlClients()
    expect(c.capabilities).toEqual(['screenshot', 'send_prompt'])
  })
})

describe('web_control_revoke handler', () => {
  it('removes a client for a control-panel caller', () => {
    run('web_control_advertise', { ...ADVERTISE }, CONTROL_PANEL)
    expect(listWebControlClients()).toHaveLength(1)
    const replies = run('web_control_revoke', { clientId: 'web_h1' }, CONTROL_PANEL)
    expect(replies[0]).toMatchObject({ type: 'web_control_revoke_ack', ok: true })
    expect(listWebControlClients()).toHaveLength(0)
  })
})
