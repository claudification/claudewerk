/**
 * Test harness for the node-stats handler tests. Shared by the ingest tests and
 * the capability-rejection tests so both drive the SAME fake context.
 *
 * fallow-ignore-next-line unused
 */

import type { ServerWebSocket } from 'bun'
import type { NodeStatsReport } from '../../shared/node-stats'
import { FIXTURE_MACHINE, FIXTURE_REPORTER_IDENTITY, FIXTURE_SAMPLED_AT } from '../../shared/node-stats-fixture'
import { buildNodeStatsReport } from '../../shared/node-stats-sample'
import type { HandlerContext, WsData } from '../handler-context'

export const HARNESS_MACHINE = FIXTURE_MACHINE

/**
 * A wire frame, built from the shared builder and then bent -- the tests need to
 * send hostile/malformed input, but the BASE must still come from the one
 * builder or this file becomes a second declaration of the shape.
 *
 * `node.nodeId` deliberately does NOT match either credential, so every test
 * exercises the credential-stamping rule by default.
 */
export function frame(over: { node?: Partial<NodeStatsReport['node']> } & Record<string, unknown> = {}) {
  const { node, ...rest } = over
  const base = buildNodeStatsReport(
    { ...FIXTURE_REPORTER_IDENTITY, nodeId: 'wire-id', uptimeSec: 100 },
    HARNESS_MACHINE,
    FIXTURE_SAMPLED_AT,
  )
  return { ...base, node: { ...base.node, ...node }, ...rest } as Record<string, unknown>
}

export interface Harness {
  ctx: HandlerContext
  replies: Record<string, unknown>[]
  broadcasts: Record<string, unknown>[]
  logs: string[]
}

export function harness(data: Partial<WsData>): Harness {
  const replies: Record<string, unknown>[] = []
  const broadcasts: Record<string, unknown>[] = []
  const logs: string[] = []
  const push = (m: string) => logs.push(m)
  const ctx = {
    ws: { data } as ServerWebSocket<WsData>,
    reply: (m: Record<string, unknown>) => replies.push(m),
    broadcast: (m: Record<string, unknown>) => broadcasts.push(m),
    log: { info: push, error: push, debug: push },
  } as unknown as HandlerContext
  return { ctx, replies, broadcasts, logs }
}

export const asReporter = (): Harness => harness({ reporterId: 'rpt-1', reporterAlias: 'beast' })
export const asSentinel = (): Harness => harness({ isSentinel: true, sentinelId: 'snt-1', sentinelAlias: 'studio' })
export const asDashboard = (): Harness => harness({ isControlPanel: true, userName: 'jonas' })

/**
 * A sentinel socket carrying NO node id -- `isSentinel` and nothing else.
 *
 * This is the shape an admin-secret sentinel had before the broker learned to
 * stamp `resolvedSentinelId`, and it is the ONLY shape that still reaches the
 * handler's "no credential" refusal: `detectRole` calls it `sentinel`, so the
 * capability gate lets it through, and the handler then finds nothing to key a
 * row by. The absence of this harness is why the live drop shipped unnoticed --
 * every existing sentinel test supplied a `sentinelId`.
 */
export const asUnidentifiedSentinel = (): Harness => harness({ isSentinel: true })
