/**
 * Test harness for the node-stats handler tests. Shared by the ingest tests and
 * the capability-rejection tests so both drive the SAME fake context.
 *
 * fallow-ignore-next-line unused
 */

import type { ServerWebSocket } from 'bun'
import { REPORT_NODE_STATS, type ReportNodeStats } from '../../shared/node-stats'
import type { HandlerContext, WsData } from '../handler-context'

export const HARNESS_MACHINE = {
  cpuPercent: 71,
  load: { avg1: 2, avg5: 2, avg15: 2, cores: 8 },
  memory: { usedBytes: 4, totalBytes: 8 },
  disk: { usedBytes: 1, totalBytes: 4, mount: '/' },
}

/** A wire frame. `nodeId` deliberately does NOT match either credential, so the
 *  credential-stamping rule is exercised by default. */
export function frame(over: Partial<ReportNodeStats> = {}): Record<string, unknown> {
  return {
    type: REPORT_NODE_STATS,
    nodeId: 'wire-id',
    hostname: 'beast',
    platform: 'linux/x64',
    agentVersion: 'abc1234',
    uptimeSec: 100,
    sampledAt: 1_700_000_000_000,
    machine: HARNESS_MACHINE,
    ...over,
  }
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
