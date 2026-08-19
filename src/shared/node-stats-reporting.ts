/**
 * The ONE cadence runner behind the node-stats contract.
 *
 * `node-stats.ts` owns the shape and the cadence CONSTANT; `node-stats-sample.ts`
 * owns filling a frame in. This owns the TICK -- and it is shared for the same
 * reason the other two are: two senders each with their own `setInterval` is two
 * cadences waiting to drift apart, no matter how equal the constants look today.
 * There is exactly one `setInterval` in the tree that emits this frame.
 *
 * Transport-agnostic on purpose: it takes a `send` callback, not a socket. That
 * is what lets the SENTINEL ride its already-open broker connection instead of
 * dialling a second one, while the standalone reporter uses its only socket.
 */

import { NODE_STATS_INTERVAL_MS, type NodeIdentity, type NodeStatsReport, type SentinelNodeExtras } from './node-stats'
import { buildNodeStatsReport, createMachineSampler, type MachineSampler } from './node-stats-sample'

export interface NodeStatsReporterOptions {
  /** The identity block, built once. */
  identity: NodeIdentity
  /** Emit one frame. Returning false (or throwing) is treated as "not sent" and
   *  logged; the runner keeps its cadence either way. */
  send(report: NodeStatsReport): boolean | void
  /**
   * Sentinel-only extras, evaluated FRESH on every tick so the conversation
   * count is live rather than a snapshot from connect time. OMIT on a reporter:
   * an absent callback means an absent `sentinel` block on the wire, which is
   * exactly what distinguishes the two senders.
   *
   * PROFILE-ENV BOUNDARY: whatever this returns crosses to the broker, so it
   * carries profile NAMES and utilization percents only.
   */
  sentinelExtras?(): SentinelNodeExtras | undefined
  /** Structured log sink. Every skipped/failed tick is logged (LOG EVERYTHING). */
  log?(message: string): void
  /** Volume to measure. Defaults to the process cwd (the disk that, when full,
   *  kills this agent). */
  diskMount?: string
  /** Override the cadence. TESTS ONLY -- production always uses the shared
   *  constant, which is the default. */
  intervalMs?: number
  /** Injectable sampler, for tests that must not touch real hardware. */
  sampler?: MachineSampler
}

export interface NodeStatsReporter {
  /** Emit one frame right now. Returns the frame that was sent, or null when the
   *  sample or the send failed. */
  tick(): NodeStatsReport | null
  /** Start the interval. Emits one frame immediately so a freshly connected node
   *  shows up without waiting a full cadence. */
  start(): void
  stop(): void
}

export function createNodeStatsReporter(opts: NodeStatsReporterOptions): NodeStatsReporter {
  const sampler = opts.sampler ?? createMachineSampler(opts.diskMount)
  const intervalMs = opts.intervalMs ?? NODE_STATS_INTERVAL_MS
  const log = opts.log ?? (() => {})
  const label = opts.identity.nodeId
  let timer: ReturnType<typeof setInterval> | null = null

  function tick(): NodeStatsReport | null {
    let report: NodeStatsReport
    try {
      report = buildNodeStatsReport(opts.identity, sampler.sample(), Date.now(), opts.sentinelExtras?.())
    } catch (err) {
      log(`[node-stats] sample failed node=${label}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    try {
      if (opts.send(report) === false) {
        log(`[node-stats] send refused node=${label} sampledAt=${report.sampledAt}`)
        return null
      }
    } catch (err) {
      log(`[node-stats] send failed node=${label}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
    return report
  }

  function start(): void {
    if (timer) return // a reconnect path that double-starts must not double the rate
    log(`[node-stats] reporting started node=${label} sender=${opts.identity.sender} everyMs=${intervalMs}`)
    tick()
    timer = setInterval(tick, intervalMs)
    // Never hold the process open for a stats timer alone.
    timer.unref?.()
  }

  function stop(): void {
    if (!timer) return
    clearInterval(timer)
    timer = null
    log(`[node-stats] reporting stopped node=${label}`)
  }

  return { tick, start, stop }
}
