/**
 * The ONE cadence runner behind `report_node_stats`.
 *
 * Both senders start THIS -- the sentinel on its already-open broker socket
 * (no new connection, no broker-side polling), the standalone reporter on its
 * only socket. Neither owns a timer of its own, so the cadence cannot drift
 * between them: it is `NODE_STATS_INTERVAL_MS` in both cases because there is
 * only one `setInterval` in the codebase that emits this frame.
 *
 * The runner is transport-agnostic on purpose: it takes a `send` callback, not
 * a WebSocket. That is what lets the sentinel reuse its existing socket instead
 * of dialling a second one.
 */

import { NODE_STATS_INTERVAL_MS, type NodeSentinelStats, REPORT_NODE_STATS, type ReportNodeStats } from './node-stats'
import { createMachineSampler, type MachineSampler, readNodeIdentity } from './node-stats-sampler'

export interface NodeStatsReporterOptions {
  /** Stable id for this node -- a sentinelId or a reporterId. */
  nodeId: string
  /** Build identifier reported as `agentVersion`. */
  agentVersion: string
  /** Emit one frame. Returning false (or throwing) is treated as "not sent"
   *  and logged; the runner keeps its cadence either way. */
  send(frame: ReportNodeStats): boolean | void
  /**
   * Sentinel-only extras, evaluated fresh on every tick. OMIT THIS on a
   * reporter -- an absent callback means an absent `sentinel` block on the
   * wire, which is exactly what distinguishes the two senders.
   *
   * PROFILE-ENV BOUNDARY: whatever this returns crosses to the broker, so it
   * must contain profile NAMES and utilization percents only.
   */
  sentinelExtras?(): NodeSentinelStats | undefined
  /** Structured log sink. Every skipped/failed tick is logged (LOG EVERYTHING). */
  log?(message: string): void
  /** Volume to measure. Defaults to the process cwd (the disk that, when full,
   *  kills this agent). */
  diskMount?: string
  /** Override the cadence. Tests only -- production always uses the shared
   *  constant, which is the default. */
  intervalMs?: number
  /** Injectable sampler, for tests that must not touch real hardware. */
  sampler?: MachineSampler
}

export interface NodeStatsReporter {
  /** Emit one frame right now. Returns the frame that was built, or null when
   *  the send failed. */
  tick(): ReportNodeStats | null
  /** Start the interval. Emits one frame immediately so a freshly connected
   *  node shows up without waiting a full cadence. */
  start(): void
  stop(): void
}

/** Build the frame the two senders share. Exported for tests that assert the
 *  reporter's frame is shape-identical to the sentinel's minus `sentinel`. */
export function buildNodeStatsFrame(
  opts: Pick<NodeStatsReporterOptions, 'nodeId' | 'agentVersion' | 'sentinelExtras'>,
  sampler: MachineSampler,
  sampledAt: number,
): ReportNodeStats {
  const frame: ReportNodeStats = {
    type: REPORT_NODE_STATS,
    ...readNodeIdentity(opts.nodeId, opts.agentVersion),
    sampledAt,
    machine: sampler.sample(),
  }
  const extras = opts.sentinelExtras?.()
  if (extras) frame.sentinel = extras
  return frame
}

export function createNodeStatsReporter(opts: NodeStatsReporterOptions): NodeStatsReporter {
  const sampler = opts.sampler ?? createMachineSampler(opts.diskMount)
  const intervalMs = opts.intervalMs ?? NODE_STATS_INTERVAL_MS
  const log = opts.log ?? (() => {})
  let timer: ReturnType<typeof setInterval> | null = null

  function tick(): ReportNodeStats | null {
    let frame: ReportNodeStats
    try {
      frame = buildNodeStatsFrame(opts, sampler, Date.now())
    } catch (err) {
      log(`[node-stats] sample failed node=${opts.nodeId}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    try {
      if (opts.send(frame) === false) {
        log(`[node-stats] send refused node=${opts.nodeId} sampledAt=${frame.sampledAt}`)
        return null
      }
    } catch (err) {
      log(`[node-stats] send failed node=${opts.nodeId}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    return frame
  }

  function start(): void {
    if (timer) return
    log(`[node-stats] reporting started node=${opts.nodeId} everyMs=${intervalMs}`)
    tick()
    timer = setInterval(tick, intervalMs)
    // Never hold the process open for a stats timer alone.
    timer.unref?.()
  }

  function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
    log(`[node-stats] reporting stopped node=${opts.nodeId}`)
  }

  return { tick, start, stop }
}
