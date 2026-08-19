/**
 * THE WALL's host-vitals producer: the CPU ring and the projection onto
 * `WallHostVitals`.
 *
 * The sentinel already ships machine facts on its existing broker socket (the
 * node-stats contract) and `node-stats-store.ts` already keeps the latest frame
 * per node. Neither keeps a SERIES, and a sparkline is a series -- so this file
 * adds the one thing that was missing and nothing else. No second sampler, no
 * second cadence, no broker-side polling: the ring is fed from the frames that
 * were already arriving.
 *
 * WHY THE RING IS NOT IN THE WALL HUB. The hub throws its whole picture away on
 * the 1->0 subscriber transition, on purpose. If the series lived there, opening
 * the wall would show a flat sparkline that took five minutes to become a
 * sparkline. Here it fills whenever a node reports, watched or not, so a cold
 * open draws the real last five minutes on the first frame. The cost of that is
 * one number pushed per node per 5s while nobody is looking, which is the whole
 * bill.
 *
 * The ring is NOT dropped when a node disconnects. A node that comes back keeps
 * its history instead of restarting from one point, and the map is bounded by
 * the number of provisioned nodes in the fleet times 60 numbers -- a rounding
 * error next to the reason to keep it.
 */

import type { NodeStatsReport } from '../../shared/node-stats'
import { WALL_HOST_CPU_SAMPLES, type WallHostVitals } from '../../shared/wall'
import { nodeStatsStore } from '../node-stats-store'
import { publishWallHostVitals } from './index'

/** nodeId -> CPU percentages, oldest first, capped at `WALL_HOST_CPU_SAMPLES`. */
const cpuRings = new Map<string, number[]>()

/** One decimal. A meter reads to a percent and a sparkline to a pixel; shipping
 *  full float precision would be bytes spent on digits nothing renders. */
function pct(value: number): number {
  return Math.round(value * 10) / 10
}

/** `used/total` as a percentage, or undefined when the total is missing -- a
 *  meter with no denominator must render as "unknown", never as 0%. */
function share(used: number, total: number): number | undefined {
  return total > 0 ? pct((used / total) * 100) : undefined
}

/**
 * Append one sample and return the ring as it now stands.
 *
 * A frame with NO cpuPercent appends nothing. The collector omits the field when
 * its delta spanned no measurable window (the first tick after a node connects
 * or reconnects), and a ring is a time series of readings -- filing a
 * placeholder for "we did not measure" would draw a spike or a dip that the box
 * never had, and keep drawing it for the next five minutes. The series simply
 * has one fewer point; the next real sample lands 5s later.
 */
function pushCpu(nodeId: string, cpuPercent: number | undefined): number[] {
  const ring = cpuRings.get(nodeId) ?? []
  if (cpuPercent === undefined) {
    cpuRings.set(nodeId, ring)
    return ring
  }
  ring.push(pct(cpuPercent))
  if (ring.length > WALL_HOST_CPU_SAMPLES) ring.splice(0, ring.length - WALL_HOST_CPU_SAMPLES)
  cpuRings.set(nodeId, ring)
  return ring
}

/**
 * Project a node-stats frame onto the wall's compact row. `hostname` is the
 * label and `nodeId` the key, exactly as the node-stats contract insists -- two
 * networks can and do produce two `studio`s.
 */
export function wallHostVitalsFrom(report: NodeStatsReport, cpuHistory: readonly number[]): WallHostVitals {
  const { node, machine } = report
  const memPct = share(machine.memory.usedBytes, machine.memory.totalBytes)
  const diskPct = share(machine.disk.usedBytes, machine.disk.totalBytes)
  return {
    nodeId: node.nodeId,
    alias: node.hostname,
    at: report.sampledAt,
    // Absent when the frame carried no reading, which S1 already renders as a
    // dash on the neutral track -- the same treatment `memPct` and `diskPct` get
    // when their denominator is missing.
    ...(machine.cpuPercent !== undefined ? { cpuPct: pct(machine.cpuPercent) } : {}),
    ...(memPct !== undefined ? { memPct } : {}),
    ...(diskPct !== undefined ? { diskPct } : {}),
    load1: pct(machine.load.one),
    cores: machine.load.cores,
    ...(report.sentinel ? { conversations: report.sentinel.conversationCount } : {}),
    cpuHistory: [...cpuHistory],
  }
}

/**
 * Ingest one accepted frame. Called from the ONE node-stats handler, after the
 * store has recorded it -- the ring is a view of what was accepted, never a
 * second ingest path with its own idea of what is valid.
 */
export function recordWallHostVitals(report: NodeStatsReport): void {
  const history = pushCpu(report.node.nodeId, report.machine.cpuPercent)
  publishWallHostVitals(wallHostVitalsFrom(report, history))
}

/**
 * Seed the first subscriber's snapshot from the store. Nothing accumulates in
 * the hub while the wall is unwatched, so without this the pane would be empty
 * until the next 5s tick of every node.
 *
 * STALE NODES ARE SEEDED TOO. `nodes()` deliberately includes them, and the pane
 * greys a row out from its own `at`; dropping them here would make a box that
 * died two minutes ago vanish rather than say so.
 */
export function seedWallHostVitals(): number {
  const stored = nodeStatsStore.nodes()
  for (const entry of stored) {
    const seed = entry.report.machine.cpuPercent
    const history = cpuRings.get(entry.report.node.nodeId) ?? (seed === undefined ? [] : [pct(seed)])
    publishWallHostVitals(wallHostVitalsFrom(entry.report, history))
  }
  return stored.length
}

/** Test isolation. The ring is module state on purpose (one broker, one fleet),
 *  so a suite that files samples must be able to empty it. */
export function resetWallHostVitals(): void {
  cpuRings.clear()
}
