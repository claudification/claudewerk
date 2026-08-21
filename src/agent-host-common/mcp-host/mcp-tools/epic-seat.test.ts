/**
 * The `epic_seat` tool: what the SEAT does with the broker's answer.
 *
 * One question decides every test here -- does this conversation die? It dies on
 * exactly one answer (a genuine same-`(card, role)` collision) and survives
 * every other, including every way of failing to reach the broker at all. A belt
 * that kills a seat because a sentinel was restarting is a new way for the whole
 * engine to stop.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { registerEpicSeatTools } from './epic-seat'
import type { McpToolContext, ToolResult } from './types'

const realFetch = globalThis.fetch

interface Harness {
  ctx: McpToolContext
  exits: Array<{ status: string; message?: string }>
  logs: string[]
  requests: Array<Record<string, unknown>>
}

function harness(reply: object | Error, opts: { conversationId?: string | null; broker?: boolean } = {}): Harness {
  const exits: Array<{ status: string; message?: string }> = []
  const logs: string[] = []
  const requests: Array<Record<string, unknown>> = []

  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    requests.push(JSON.parse(init.body) as Record<string, unknown>)
    if (reply instanceof Error) throw reply
    return { json: async () => reply } as Response
  }) as unknown as typeof fetch

  const conversationId = opts.conversationId === undefined ? 'conv_me' : opts.conversationId
  const ctx = {
    getIdentity: () => (conversationId ? { conversationId } : null),
    elog: (m: string) => logs.push(m),
    callbacks: { onExitConversation: (status: string, message?: string) => exits.push({ status, message }) },
    brokerUrl: opts.broker === false ? undefined : 'ws://localhost:9999',
    brokerSecret: 'shh',
    noBroker: opts.broker === false,
  } as unknown as McpToolContext

  return { ctx, exits, logs, requests }
}

const run = (h: Harness, action?: string): Promise<ToolResult> =>
  registerEpicSeatTools(h.ctx).epic_seat.handle(action ? { action } : {}, { rawArgs: {}, extra: {} })

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('a granted claim', () => {
  test('reports the grant and changes nothing else', async () => {
    const h = harness({ ok: true, outcome: 'granted', note: 'You hold the implementer seat on `t1` (generation 1).' })

    const res = await run(h)

    expect(res.isError).toBeUndefined()
    expect(res.content[0].text).toContain('generation 1')
    expect(h.exits).toHaveLength(0)
  })

  test("it sends the caller's own conversation id and NOTHING else about the seat", async () => {
    const h = harness({ ok: true, outcome: 'granted', note: 'held' })

    await run(h, 'claim')

    expect(h.requests[0]).toEqual({ conversationId: 'conv_me', action: 'claim' })
  })

  test('release is the only other action, and an unknown one falls back to claim', async () => {
    const h = harness({ ok: true, outcome: 'released', note: 'released' })
    await run(h, 'release')
    expect(h.requests[0].action).toBe('release')

    const h2 = harness({ ok: true, outcome: 'granted', note: 'held' })
    await run(h2, 'steal')
    expect(h2.requests[0].action).toBe('claim')
  })
})

describe('a refusal -- the loser exits, non-zero and loudly', () => {
  const refusal = {
    ok: false,
    outcome: 'refused',
    exit: true as const,
    note: 'SEAT LEASE REFUSED for `t1` (implementer).\nConversation `conv_first` already holds this seat. STOP NOW.',
  }

  test('the conversation is exited with an ERROR status, not asked to stop', async () => {
    const h = harness(refusal)

    const res = await run(h)

    expect(h.exits).toEqual([{ status: 'error', message: expect.stringContaining('seat lease refused') }])
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('conv_first')
  })

  test('the refusal reaches the host log too, so it survives the transcript', async () => {
    const h = harness(refusal)
    await run(h)
    expect(h.logs.join('\n')).toContain('EXIT')
  })
})

/**
 * THE "DO NOT" CLAUSE, in tests. A seat that cannot reach the broker must not be
 * unable to work: the lease is a mutex between seats, never an authorisation
 * gate.
 */
describe('unreachable is not refused', () => {
  test('a fetch that throws tells the seat to PROCEED, and is not an error', async () => {
    const h = harness(new Error('ECONNREFUSED'))

    const res = await run(h)

    expect(res.isError).toBeUndefined()
    expect(res.content[0].text).toContain('PROCEED')
    expect(res.content[0].text).toContain('ECONNREFUSED')
    expect(h.exits).toHaveLength(0)
  })

  test('no broker connection at all: PROCEED, without a request', async () => {
    const h = harness({}, { broker: false })

    const res = await run(h)

    expect(res.content[0].text).toContain('PROCEED')
    expect(h.requests).toHaveLength(0)
    expect(h.exits).toHaveLength(0)
  })

  test('a host that does not know its own conversation id yet: PROCEED', async () => {
    const h = harness({}, { conversationId: null })

    const res = await run(h)

    expect(res.content[0].text).toContain('PROCEED')
    expect(h.requests).toHaveLength(0)
  })

  test('a dead sentinel behind a live broker also means PROCEED -- there is no holder in that answer', async () => {
    const h = harness({
      ok: false,
      outcome: 'error',
      status: 502,
      note: 'could not read the seat lease: no sentinel connected',
    })

    const res = await run(h)

    expect(res.isError).toBeUndefined()
    expect(res.content[0].text).toContain('PROCEED')
    expect(h.exits).toHaveLength(0)
  })

  test('an answer with no status at all is treated as unreachable -- the survivable half of the guess', async () => {
    const h = harness({ ok: false, outcome: 'error', note: 'something went wrong' })
    expect((await run(h)).content[0].text).toContain('PROCEED')
  })
})

/**
 * Not a seat, wrong card, no permission: real refusals of the CALLER, which the
 * conversation must SURVIVE -- a tool that could kill any conversation calling
 * it would be worse than the corruption it prevents. But it must not be told to
 * carry on unprotected either: it is not entitled to ask, and that is a fact to
 * report, not a transport blip to route around.
 */
describe('a refusal of the caller is an error, never an exit and never a PROCEED', () => {
  test('a session with no epic launch tag is told so, lives, and is not told to proceed', async () => {
    const h = harness({
      ok: false,
      outcome: 'error',
      status: 403,
      note: 'the seat lease is for WERK-launched seats only -- this conversation carries no epic launch tag',
    })

    const res = await run(h)

    expect(h.exits).toHaveLength(0)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('WERK-launched')
    expect(res.content[0].text).not.toContain('PROCEED')
  })

  test('a cardId the caller was not dispatched for is an error it must not shrug off', async () => {
    const h = harness({
      ok: false,
      outcome: 'error',
      status: 403,
      note: 'you were dispatched onto `t1`, not `t2` -- a seat may only claim its own card',
    })

    const res = await run(h)

    expect(res.isError).toBe(true)
    expect(h.exits).toHaveLength(0)
  })
})
