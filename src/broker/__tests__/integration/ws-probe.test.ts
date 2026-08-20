/**
 * `ws_ping` -> `ws_pong`: the one application-level echo on the dashboard socket,
 * and the only thing that makes a round trip measurable from the browser.
 *
 * What the broker owes the client is exactly this much: the same token back, no
 * state kept, no clock read. Everything about the MEASUREMENT lives client-side
 * in `web/src/hooks/ws-rtt.ts` and is tested there.
 */

import { describe, expect, it } from 'bun:test'
import { WS_PROBE_TOKEN_MAX } from '../../../shared/ws-probe'
import { createTestHarness } from './test-harness'

function pongs(ws: { messagesOfType(type: string): Record<string, unknown>[] }): Record<string, unknown>[] {
  return ws.messagesOfType('ws_pong')
}

describe('ws round-trip probe', () => {
  it('echoes the token verbatim', () => {
    const h = createTestHarness()
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, { type: 'ws_ping', token: 'rtt-7' })

    expect(pongs(dashboard)).toHaveLength(1)
    expect(pongs(dashboard)[0].token).toBe('rtt-7')
    h.cleanup()
  })

  it('answers every probe independently -- the broker keeps no pending state', () => {
    const h = createTestHarness()
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    for (const token of ['rtt-1', 'rtt-2', 'rtt-3']) {
      h.dashboardSend(dashboard, { type: 'ws_ping', token })
    }

    expect(pongs(dashboard).map(m => m.token)).toEqual(['rtt-1', 'rtt-2', 'rtt-3'])
    h.cleanup()
  })

  it('sends a probe nothing but its own answer', () => {
    const h = createTestHarness()
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    h.dashboardSend(dashboard, { type: 'ws_ping', token: 'rtt-1' })

    // No frame, no counter, no broadcast rides along: a probe that pulled state
    // with it would be measuring the state, not the wire.
    expect(dashboard.sent.map(m => m.type)).toEqual(['ws_pong'])
    h.cleanup()
  })

  it('drops a token it could not echo intact', () => {
    const h = createTestHarness()
    const dashboard = h.connectDashboard()
    dashboard.clearMessages()

    for (const token of [undefined, '', 42, { nested: true }, 'x'.repeat(WS_PROBE_TOKEN_MAX + 1)]) {
      h.dashboardSend(dashboard, { type: 'ws_ping', token })
    }

    // Silence, not an error reply: the client discards pongs it cannot match
    // anyway, so an error would only be a second thing to echo.
    expect(pongs(dashboard)).toHaveLength(0)
    h.cleanup()
  })

  it('is not reachable from an agent host', () => {
    const h = createTestHarness()
    const agent = h.bootAgentHost({ conversationId: 'conv-probe', project: 'claude:///home/user/project' })
    agent.clearMessages()

    h.agentSend(agent, { type: 'ws_ping', token: 'rtt-1' })

    expect(pongs(agent)).toHaveLength(0)
    expect(agent.messagesOfType('ws_ping_result')[0]?.ok).toBe(false)
    h.cleanup()
  })
})
