/**
 * A request the socket cannot carry must FAIL, and say so.
 *
 * REGRESSION (2026-08-19, found live): `sendWsMessage` dropped the payload on the
 * floor whenever the socket was not OPEN -- no queue, no throw, nothing logged.
 * The channel had already armed its 12s timer, so clicking a board card during a
 * reconnect sat there for twelve seconds and then reported
 * `sentinel timed out (10s)` -- blaming a sentinel that was never asked anything.
 * Neither the broker log nor the sentinel log had a single line about it, because
 * the request never left the browser.
 *
 * Two things are asserted here, and they are different promises:
 *   1. a socket that comes up in time still carries the request (self-heal), and
 *   2. a socket that never comes up rejects PROMPTLY and names the real cause.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { createWsRequestChannel } from './ws-request'

/** A socket stub whose readyState we drive by hand. */
function fakeSocket(readyState: number) {
  const sent: string[] = []
  return {
    sent,
    socket: { readyState, send: (p: string) => sent.push(p) } as unknown as WebSocket,
  }
}

function installSocket(readyState: number) {
  const fake = fakeSocket(readyState)
  useConversationsStore.setState({ ws: fake.socket })
  return fake
}

beforeEach(() => {
  useConversationsStore.setState({ ws: null })
})

describe('ws request channel -- a send that cannot happen', () => {
  it('rejects promptly, naming the connection, instead of a phantom timeout', async () => {
    const channel = createWsRequestChannel('project', 10_000, 150)
    const fake = installSocket(WebSocket.CONNECTING)

    const started = Date.now()
    await expect(channel.send({ type: 'project_board_request', op: 'get' })).rejects.toThrow(/not connected/i)

    // The point of the fix: it must NOT sit on the 10s request timer.
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(fake.sent).toEqual([])
  })

  it('delivers once the socket opens, rather than dropping the frame', async () => {
    const channel = createWsRequestChannel('project', 10_000, 2_000)
    const fake = installSocket(WebSocket.CONNECTING)

    const inflight = channel.send({ type: 'project_board_request', op: 'get' })
    ;(fake.socket as unknown as { readyState: number }).readyState = WebSocket.OPEN

    // Let the retry land, then answer it the way the broker would.
    await new Promise(r => setTimeout(r, 120))
    expect(fake.sent).toHaveLength(1)
    const requestId = (JSON.parse(fake.sent[0]) as { requestId: string }).requestId
    channel.settle({ type: 'project_board_result', requestId, ok: true, task: { slug: 'x' } })

    await expect(inflight).resolves.toMatchObject({ ok: true })
  })

  it('sends straight away when the socket is already open', async () => {
    const channel = createWsRequestChannel('project', 10_000, 2_000)
    const fake = installSocket(WebSocket.OPEN)

    const inflight = channel.send({ type: 'project_board_request', op: 'get' })
    await Promise.resolve()
    expect(fake.sent).toHaveLength(1)

    const requestId = (JSON.parse(fake.sent[0]) as { requestId: string }).requestId
    channel.settle({ type: 'project_board_result', requestId, ok: true })
    await expect(inflight).resolves.toMatchObject({ ok: true })
  })

  it('still rejects with the broker error when the broker answers with one', async () => {
    const channel = createWsRequestChannel('project', 10_000, 2_000)
    const fake = installSocket(WebSocket.OPEN)

    const inflight = channel.send({ type: 'project_board_request', op: 'get' })
    await Promise.resolve()
    const requestId = (JSON.parse(fake.sent[0]) as { requestId: string }).requestId
    channel.settle({ type: 'project_board_result', requestId, ok: false, error: 'sentinel timed out (10s)' })

    await expect(inflight).rejects.toThrow('sentinel timed out (10s)')
  })
})
