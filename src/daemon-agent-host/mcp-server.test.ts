/**
 * Tests for the daemon-host local HTTP router. The MCP channel itself is covered
 * in agent-host-common; here we assert the request routing -- health, the /mcp
 * path (which 503s until the channel is initialized), and the 404 fall-through.
 */

import { describe, expect, test } from 'bun:test'
import { handleDaemonHttp } from './mcp-server'

describe('handleDaemonHttp', () => {
  test('/health returns ok', async () => {
    const res = await handleDaemonHttp(new Request('http://127.0.0.1/health'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  test('/mcp routes to the MCP channel (503 before init)', async () => {
    const res = await handleDaemonHttp(new Request('http://127.0.0.1/mcp', { method: 'POST' }))
    // No initMcpChannel in this unit test -> handleMcpRequest reports 503; the
    // point is the path reaches the channel handler rather than 404ing.
    expect(res.status).not.toBe(404)
  })

  test('unknown path 404s', async () => {
    const res = await handleDaemonHttp(new Request('http://127.0.0.1/nope'))
    expect(res.status).toBe(404)
  })
})
