/**
 * Card `sentinel-node-stats-dropped-no-credential`.
 *
 * THE LIVE BUG. `studio` -- the box running the entire fleet -- authenticates
 * its sentinel with the shared `RCLAUDE_SECRET` rather than a per-sentinel
 * `snt_` secret. `resolveAuth` maps that to `{ role: 'admin' }`, which carries
 * no `sentinelId`; `sentinel_identify` then set `isSentinel` but nothing else,
 * so `credentialIdentity()` found no node credential and the broker binned
 * EVERY `node_stats` frame. The live log read 606 `sender=reporter`, zero
 * `sender=sentinel`, and 280 `carries no sentinel/reporter credential` rejects
 * -- the rejects proving the frames were arriving and being thrown away.
 *
 * The broker was never actually missing an identity for that socket: it had
 * already resolved one. `setSentinel()` falls back to the registry's DEFAULT
 * sentinel record (creating it when absent) for exactly this legacy/admin auth,
 * and then dropped the resolved id on the floor instead of stamping it on the
 * connection.
 *
 * These tests drive the REAL router through the REAL sequence a sentinel
 * performs on connect -- identify, then report -- because the bug lives in the
 * seam between those two messages, and neither one alone shows it.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { NODE_STATS_MESSAGE } from '../../shared/node-stats'
import { type ConversationStore, createConversationStore } from '../conversation-store'
import type { HandlerContext, WsData } from '../handler-context'
import { routeMessage } from '../message-router'
import { nodeStatsStore } from '../node-stats-store'
import { createSentinelRegistry, type SentinelRegistry } from '../sentinel-registry'
import { createMemoryDriver } from '../store/memory/driver'
import { registerAllHandlers } from './index'
import { asUnidentifiedSentinel, frame } from './node-stats-harness'

registerAllHandlers()

let conversationStore: ConversationStore
let sentinelRegistry: SentinelRegistry

interface Socket {
  ctx: HandlerContext
  data: WsData
  logs: string[]
  replies: Record<string, unknown>[]
}

/**
 * A socket authenticated with the plain admin secret: no `sentinelId`, no
 * `reporterId`, no role marker at all. `detectRole` calls this `agent-host`
 * until `sentinel_identify` lands -- which is precisely the live shape.
 */
function adminSocket(): Socket {
  const data: WsData = {}
  const logs: string[] = []
  const replies: Record<string, unknown>[] = []
  const push = (m: string) => logs.push(m)
  const ws = {
    data,
    readyState: 1,
    send: () => 0,
    close: () => {},
  } as unknown as ServerWebSocket<WsData>
  const ctx = {
    ws,
    conversations: conversationStore,
    reply: (m: Record<string, unknown>) => replies.push(m),
    broadcast: () => {},
    broadcastScoped: () => {},
    log: { info: push, error: push, debug: push },
  } as unknown as HandlerContext
  return { ctx, data, logs, replies }
}

/** What studio actually sends on connect: a self-reported machineId, and no
 *  knowledge whatsoever of any broker-side id. */
function identify(s: Socket, over: Record<string, unknown> = {}): void {
  routeMessage(s.ctx, 'sentinel_identify', {
    type: 'sentinel_identify',
    machineId: 'f5c8797a367b0ec0',
    hostname: 'studio',
    ...over,
  })
}

beforeEach(() => {
  nodeStatsStore.clear()
  const store = createMemoryDriver()
  store.init()
  sentinelRegistry = createSentinelRegistry(mkdtempSync(join(tmpdir(), 'rclaude-admin-sentinel-')))
  conversationStore = createConversationStore({ store, sentinelRegistry, enablePersistence: false })
})

describe('an admin-authenticated sentinel reports its vitals', () => {
  it('ingests node_stats after identify, instead of binning every frame', () => {
    // THE REGRESSION. Before the fix this stored nothing and logged the reject.
    const s = adminSocket()
    identify(s)
    routeMessage(s.ctx, NODE_STATS_MESSAGE, frame({ node: { sender: 'sentinel' } }))

    expect(nodeStatsStore.size()).toBe(1)
    expect(s.logs.some(l => l.includes('carries no sentinel/reporter credential'))).toBe(false)
  })

  it('stores the row under the registry-resolved id with sender=sentinel', () => {
    const s = adminSocket()
    identify(s)
    routeMessage(s.ctx, NODE_STATS_MESSAGE, frame({ node: { sender: 'sentinel' } }))

    const defaultId = sentinelRegistry.getDefaultId()
    expect(defaultId).toBeTruthy()
    const row = nodeStatsStore.get(defaultId as string)
    expect(row?.report.node.sender).toBe('sentinel')
  })

  it('keeps the sentinel EXTRAS that only a sentinel frame may carry', () => {
    // Proof the frame is treated as a genuine sentinel frame, not smuggled
    // through as a reporter: the validator's extras rule lets these live.
    const s = adminSocket()
    identify(s)
    routeMessage(s.ctx, NODE_STATS_MESSAGE, frame({ node: { sender: 'sentinel' }, sentinel: { conversationCount: 7 } }))

    const row = nodeStatsStore.get(sentinelRegistry.getDefaultId() as string)
    expect(row?.report.sentinel).toEqual({ conversationCount: 7 })
  })

  it('TRUSTS NOTHING FROM THE WIRE: the row is never keyed by the reported machineId', () => {
    // `machineId` is attacker-controlled and is the obvious stable-looking
    // source for a derived id. It must never become the node id, or a socket
    // could claim another node's row by naming it.
    const s = adminSocket()
    identify(s, { machineId: 'snt-1' })
    routeMessage(s.ctx, NODE_STATS_MESSAGE, frame({ node: { nodeId: 'snt-1', sender: 'sentinel' } }))

    expect(nodeStatsStore.get('snt-1')).toBeUndefined()
    expect(nodeStatsStore.get('f5c8797a367b0ec0')).toBeUndefined()
    expect(nodeStatsStore.get(sentinelRegistry.getDefaultId() as string)).toBeDefined()
  })

  it('is STABLE across reconnects, so the wall shows one studio and not N', () => {
    // A fresh id per identify (timestamp / counter / randomUUID) would give
    // studio a new row on every sentinel restart, with the stale ones sitting
    // on the wall until they age out.
    const first = adminSocket()
    identify(first)
    routeMessage(first.ctx, NODE_STATS_MESSAGE, frame({ node: { sender: 'sentinel' }, sampledAt: 10 }))

    const second = adminSocket()
    identify(second)
    routeMessage(second.ctx, NODE_STATS_MESSAGE, frame({ node: { sender: 'sentinel' }, sampledAt: 20 }))

    expect(second.data.resolvedSentinelId).toBe(first.data.resolvedSentinelId as string)
    expect(nodeStatsStore.size()).toBe(1)
  })

  it('does not shadow a per-secret sentinel: an snt_ credential still wins', () => {
    const record = sentinelRegistry.create({ alias: 'beast', generateSecret: true })
    const s = adminSocket()
    s.data.sentinelId = record.sentinelId
    identify(s)
    routeMessage(s.ctx, NODE_STATS_MESSAGE, frame({ node: { sender: 'sentinel' } }))

    expect(nodeStatsStore.get(record.sentinelId)).toBeDefined()
  })
})

/**
 * The refusal that remains. A socket the router calls `sentinel` but which
 * carries no id at all still cannot be keyed to a row -- a shell-data pipe, or
 * a sentinel whose identify was rejected. It reaches the handler (the
 * capability gate passes it), so the handler must refuse it WELL.
 */
describe('a sentinel socket with no id is refused, but told', () => {
  it('drops the frame and says so ONCE, not on every 5s tick', () => {
    // The reject logged at info on EVERY frame, forever -- the same 17k-lines-a
    // -day trap the identity-stamp line already latches against. 280 of these
    // were sitting in the live log.
    const h = asUnidentifiedSentinel()
    for (let i = 0; i < 5; i++) routeMessage(h.ctx, NODE_STATS_MESSAGE, frame())

    expect(nodeStatsStore.size()).toBe(0)
    expect(h.logs.filter(l => l.includes('carries no sentinel/reporter credential')).length).toBe(1)
  })

  it('answers with a typed message, not log-only silence', () => {
    // EVERYTHING IS A STRUCTURED MESSAGE: a sender that is being ignored must
    // be TOLD, or it reports into the void exactly as studio did for months.
    const h = asUnidentifiedSentinel()
    routeMessage(h.ctx, NODE_STATS_MESSAGE, frame())

    const reply = h.replies.find(r => r.type === `${NODE_STATS_MESSAGE}_result`)
    expect(reply?.ok).toBe(false)
    expect(String(reply?.error)).toContain('credential')
  })

  it('tells the sender every time, even though it only logs once', () => {
    // The LATCH is a log-volume guard. Muting the reply as well would leave a
    // reconnecting sender with no way to learn it is being ignored.
    const h = asUnidentifiedSentinel()
    for (let i = 0; i < 3; i++) routeMessage(h.ctx, NODE_STATS_MESSAGE, frame())

    expect(h.replies.filter(r => r.type === `${NODE_STATS_MESSAGE}_result`).length).toBe(3)
  })
})
