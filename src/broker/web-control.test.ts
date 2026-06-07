import { afterEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { WEB_CONTROL_MAX_GRANT_MS } from '../shared/protocol'
import type { WsData } from './handler-context'
import {
  __resetWebControlForTests,
  advertiseWebControl,
  listWebControlClients,
  resolveImplicitClient,
  resolveWebControlResponse,
  revokeWebControl,
  revokeWebControlBySocket,
  sendWebControlRequest,
} from './web-control'

interface FakeWs {
  data: WsData
  sent: string[]
  send(s: string): void
}

function makeWs(userName = 'jonas'): FakeWs {
  const ws: FakeWs = {
    data: { userName, userAgent: 'TestBrowser/1.0' } as WsData,
    sent: [],
    send(s: string) {
      this.sent.push(s)
    },
  }
  return ws
}

function asWs(ws: FakeWs): ServerWebSocket<WsData> {
  return ws as unknown as ServerWebSocket<WsData>
}

const CAPS = ['screenshot', 'list_commands', 'execute_command'] as const

afterEach(() => {
  __resetWebControlForTests()
})

describe('web-control registry', () => {
  test('advertise then list shows the client', () => {
    const ws = makeWs()
    advertiseWebControl(asWs(ws), {
      clientId: 'web_abc',
      grantId: 'g1',
      expiresAt: Date.now() + 60_000,
      capabilities: [...CAPS],
      label: 'Mac / Chrome',
    })
    const list = listWebControlClients()
    expect(list).toHaveLength(1)
    expect(list[0].clientId).toBe('web_abc')
    expect(list[0].userName).toBe('jonas')
    expect(list[0].capabilities).toEqual([...CAPS])
    expect(list[0].ttlMs).toBeGreaterThan(0)
  })

  test('broker clamps an over-long grant to the 1h ceiling', () => {
    const ws = makeWs()
    advertiseWebControl(asWs(ws), {
      clientId: 'web_greedy',
      grantId: 'g1',
      expiresAt: Date.now() + 999 * 60 * 60 * 1000, // 999h claimed
      capabilities: [...CAPS],
    })
    const [c] = listWebControlClients()
    expect(c.ttlMs).toBeLessThanOrEqual(WEB_CONTROL_MAX_GRANT_MS)
  })

  test('an already-expired grant is never listed (default-deny on expiry)', () => {
    const ws = makeWs()
    advertiseWebControl(asWs(ws), {
      clientId: 'web_old',
      grantId: 'g1',
      expiresAt: Date.now() - 1, // already expired
      capabilities: [...CAPS],
    })
    expect(listWebControlClients()).toHaveLength(0)
  })

  test('resolveImplicitClient: 0 -> error, 1 -> that one, 2 -> error', () => {
    expect('error' in resolveImplicitClient()).toBe(true)
    const a = makeWs()
    advertiseWebControl(asWs(a), {
      clientId: 'web_a',
      grantId: 'g',
      expiresAt: Date.now() + 60_000,
      capabilities: [...CAPS],
    })
    expect(resolveImplicitClient()).toEqual({ clientId: 'web_a' })
    const b = makeWs('other')
    advertiseWebControl(asWs(b), {
      clientId: 'web_b',
      grantId: 'g',
      expiresAt: Date.now() + 60_000,
      capabilities: [...CAPS],
    })
    expect('error' in resolveImplicitClient()).toBe(true)
  })

  test('re-advertise from a fresh socket replaces the entry without duplicating', () => {
    const ws1 = makeWs()
    advertiseWebControl(asWs(ws1), {
      clientId: 'web_x',
      grantId: 'g1',
      expiresAt: Date.now() + 60_000,
      capabilities: [...CAPS],
    })
    const ws2 = makeWs()
    advertiseWebControl(asWs(ws2), {
      clientId: 'web_x',
      grantId: 'g2',
      expiresAt: Date.now() + 60_000,
      capabilities: [...CAPS],
    })
    const list = listWebControlClients()
    expect(list).toHaveLength(1)
    expect(list[0].grantId).toBe('g2')
    // Closing the OLD socket must not drop the freshly-advertised entry.
    revokeWebControlBySocket(asWs(ws1))
    expect(listWebControlClients()).toHaveLength(1)
  })
})

describe('web-control request/response correlation', () => {
  test('send -> response resolves the pending op with the result', async () => {
    const ws = makeWs()
    advertiseWebControl(asWs(ws), {
      clientId: 'web_r',
      grantId: 'g',
      expiresAt: Date.now() + 60_000,
      capabilities: [...CAPS],
    })

    const promise = sendWebControlRequest('web_r', 'list_commands', {})
    expect(ws.sent).toHaveLength(1)
    const sent = JSON.parse(ws.sent[0])
    expect(sent.type).toBe('web_control_request')
    expect(sent.op).toBe('list_commands')

    const matched = resolveWebControlResponse({
      requestId: sent.requestId,
      ok: true,
      result: [{ id: 'foo', label: 'Foo' }],
    })
    expect(matched).toBe(true)
    const r = await promise
    expect(r.ok).toBe(true)
    expect(r.result).toEqual([{ id: 'foo', label: 'Foo' }])
  })

  test('unknown client -> error, never sends', async () => {
    const r = await sendWebControlRequest('web_nope', 'screenshot', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('web_nope')
  })

  test('unsupported op for this client -> error', async () => {
    const ws = makeWs()
    advertiseWebControl(asWs(ws), {
      clientId: 'web_lim',
      grantId: 'g',
      expiresAt: Date.now() + 60_000,
      capabilities: ['screenshot'],
    })
    const r = await sendWebControlRequest('web_lim', 'send_prompt', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('send_prompt')
  })

  test('late/unmatched response is a no-op', () => {
    expect(resolveWebControlResponse({ requestId: 'wcr_ghost', ok: true })).toBe(false)
  })

  test('disconnect fails an in-flight op instead of hanging', async () => {
    const ws = makeWs()
    advertiseWebControl(asWs(ws), {
      clientId: 'web_d',
      grantId: 'g',
      expiresAt: Date.now() + 60_000,
      capabilities: [...CAPS],
    })
    const promise = sendWebControlRequest('web_d', 'screenshot', {})
    revokeWebControlBySocket(asWs(ws))
    const r = await promise
    expect(r.ok).toBe(false)
    expect(r.error).toContain('disconnected')
  })

  test('explicit revoke removes the client and fails its in-flight ops', async () => {
    const ws = makeWs()
    advertiseWebControl(asWs(ws), {
      clientId: 'web_rv',
      grantId: 'g',
      expiresAt: Date.now() + 60_000,
      capabilities: [...CAPS],
    })
    const promise = sendWebControlRequest('web_rv', 'screenshot', {})
    revokeWebControl('web_rv', 'test')
    expect(listWebControlClients()).toHaveLength(0)
    const r = await promise
    expect(r.ok).toBe(false)
  })
})
