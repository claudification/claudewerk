/**
 * NODE STATS -- one contract, two senders.
 *
 * `node_stats` is the single wire message carrying a machine's vitals. It has
 * exactly two senders and they share this module:
 *
 *   1. the SENTINEL -- which also spawns, distributes credentials and runs
 *      shells, and therefore additionally knows how many conversations are
 *      running on the box;
 *   2. the standalone NODE-STATS-REPORTER -- which can do nothing else, holds
 *      a minimal-privilege `rpt_` credential, and simply omits the extras.
 *
 * Same payload, same cadence, same validation, same broker handler. A second
 * definition of this shape in either sender is the drift `feedback_no_duplication`
 * exists to prevent, so the types, the cadence constant, the validator and the
 * per-host dedupe all live here and nowhere else. The COLLECTOR that fills the
 * shape lives next door in `node-stats-sample.ts` (node-only runtime; this file
 * stays dependency-free so the web bundle can import the types).
 *
 * WHAT IS NOT ON THIS PAYLOAD: plan utilization. Per-profile plan windows ride
 * `sentinel_usage_report` (`ProfileUsageSnapshot` in `protocol.ts`) and are read
 * back via `getSentinelProfileUsage()`. There is exactly one utilization path and
 * this is not it -- node stats carry MACHINE facts plus the conversation count.
 *
 * PROFILE-ENV BOUNDARY (`src/sentinel/sentinel-config.ts`): nothing here carries
 * a config dir, an env bag or an oauth token. The payload has no profile fields
 * at all.
 */

/**
 * Sampling cadence, shared by both senders. One sample every 5s, emitted on the
 * sender's existing connection tick -- neither sender gets to pick its own
 * number, or the broker ring's time axis stops meaning anything.
 */
export const NODE_STATS_INTERVAL_MS = 5_000

/**
 * How long a node may go silent before a consumer must treat its last sample as
 * stale rather than live. Three missed samples: long enough to ride out one slow
 * tick, short enough that a dead reporter greys out inside a screen-refresh.
 */
export const NODE_STATS_STALE_AFTER_MS = NODE_STATS_INTERVAL_MS * 3

/** Which of the two senders produced a frame. Drives nothing but display and
 *  the "extras are allowed here" validation rule. */
export type NodeStatsSender = 'sentinel' | 'reporter'

/**
 * Who is reporting, and from where.
 *
 * `nodeId` is per AGENT, `hostId` is per HOST. Two agents on one box (a sentinel
 * and a reporter, or two sentinels) share a `hostId` and MUST NOT double-count
 * the machine -- see `dedupeMachineStatsByHost`. Rows are keyed by `nodeId` and
 * labelled by `hostname`.
 */
export interface NodeIdentity {
  /** Stable id for this AGENT. Unique per sender, even on a shared box. */
  nodeId: string
  /** Stable fingerprint of the BOX. Shared by every agent on it; the dedupe key
   *  for machine facts. Hostname is a label, not a key -- two networks can and
   *  do produce two `studio`s. */
  hostId: string
  /** Display label, e.g. `studio`. Never used as an identity key. */
  hostname: string
  /** OS/arch label, e.g. `darwin/arm64`. One string; consumers render it as-is. */
  osArch: string
  /** Version of the agent binary sending this frame. */
  agentVersion: string
  /** Seconds the HOST has been up (not the agent process). */
  uptimeSec: number
  /** Which sender built the frame. A `reporter` frame carrying `sentinel`
   *  extras is rejected by `validateNodeStats`. */
  sender: NodeStatsSender
}

/** Load average with the core count it should be read against. A load of 8 is
 *  idle on a 32-core box and on fire on a 4-core one; shipping the divisor with
 *  the number is the difference between a meter and a decoration. */
export interface LoadAverage {
  one: number
  five: number
  fifteen: number
  cores: number
}

/** Bytes used out of bytes total. Percentages are a rendering concern. */
export interface UsedTotal {
  usedBytes: number
  totalBytes: number
}

/** Machine facts. Per HOST -- identical for every agent on the same box. */
export interface MachineStats {
  /** Whole-box CPU utilization over the last sampling interval, 0-100. */
  cpuPercent: number
  load: LoadAverage
  memory: UsedTotal
  /** The volume the agent runs on, plus the mount point it was measured at so a
   *  consumer can tell `/` from an external disk. */
  disk: UsedTotal & { mount: string }
}

/**
 * Facts only a SENTINEL can know. Optional on the shape and absent -- not
 * zeroed -- from a reporter frame, so "no reporter data" and "reporter with
 * nothing running" stay distinguishable.
 */
export interface SentinelNodeExtras {
  /** Conversations currently running under this sentinel. */
  conversationCount: number
}

/** The wire message. Sentinel and reporter both send exactly this. */
export interface NodeStatsReport {
  type: 'node_stats'
  node: NodeIdentity
  machine: MachineStats
  /** Present only on a sentinel frame. */
  sentinel?: SentinelNodeExtras
  /** ms epoch the sample was taken (not when it was sent). */
  sampledAt: number
}

/** Validation outcome. Both senders and the broker handler run the same check,
 *  so a malformed reporter frame and a malformed sentinel frame fail the same
 *  way with the same reasons. */
export type NodeStatsValidation = { ok: true; report: NodeStatsReport } | { ok: false; errors: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Finite number check that also rejects NaN/Infinity, which JSON.parse happily
 *  produces from `null`-ish arithmetic upstream. */
function num(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function checkIdentity(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('node: expected an object')
    return
  }
  for (const key of ['nodeId', 'hostId', 'hostname', 'osArch', 'agentVersion'] as const) {
    if (!nonEmptyString(value[key])) errors.push(`node.${key}: expected a non-empty string`)
  }
  if (!num(value.uptimeSec) || value.uptimeSec < 0) errors.push('node.uptimeSec: expected a non-negative number')
  if (value.sender !== 'sentinel' && value.sender !== 'reporter') {
    errors.push("node.sender: expected 'sentinel' or 'reporter'")
  }
}

function checkUsedTotal(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object`)
    return
  }
  if (!num(value.usedBytes) || value.usedBytes < 0) errors.push(`${path}.usedBytes: expected a non-negative number`)
  if (!num(value.totalBytes) || value.totalBytes < 0) errors.push(`${path}.totalBytes: expected a non-negative number`)
  if (num(value.usedBytes) && num(value.totalBytes) && value.usedBytes > value.totalBytes) {
    errors.push(`${path}: usedBytes exceeds totalBytes`)
  }
}

function checkLoad(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('machine.load: expected an object')
    return
  }
  for (const key of ['one', 'five', 'fifteen'] as const) {
    const reading = value[key]
    if (!num(reading) || reading < 0) errors.push(`machine.load.${key}: expected a non-negative number`)
  }
  // Cores is the divisor the load is read against, so a zero would make the
  // whole triple meaningless rather than merely wrong.
  if (!num(value.cores) || value.cores < 1) errors.push('machine.load.cores: expected a positive number')
}

function checkDisk(value: unknown, errors: string[]): void {
  checkUsedTotal(value, 'machine.disk', errors)
  if (isRecord(value) && !nonEmptyString(value.mount)) {
    errors.push('machine.disk.mount: expected a non-empty string')
  }
}

function checkMachine(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('machine: expected an object')
    return
  }
  if (!num(value.cpuPercent) || value.cpuPercent < 0 || value.cpuPercent > 100) {
    errors.push('machine.cpuPercent: expected a number in 0..100')
  }
  checkLoad(value.load, errors)
  checkUsedTotal(value.memory, 'machine.memory', errors)
  checkDisk(value.disk, errors)
}

/**
 * The ONE validator. A reporter payload and a sentinel payload are checked by
 * this function and no other; the only asymmetry is the extras rule, which is
 * derived from `node.sender` rather than from who happens to be calling.
 */
export function validateNodeStats(value: unknown): NodeStatsValidation {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ['expected an object'] }
  if (value.type !== 'node_stats') errors.push("type: expected 'node_stats'")

  checkIdentity(value.node, errors)
  checkMachine(value.machine, errors)

  if (!num(value.sampledAt) || value.sampledAt <= 0) errors.push('sampledAt: expected a positive ms epoch')

  if (value.sentinel !== undefined) {
    const sender = isRecord(value.node) ? value.node.sender : undefined
    if (sender === 'reporter') {
      errors.push('sentinel: sentinel-only extras are not allowed on a reporter frame')
    } else if (!isRecord(value.sentinel)) {
      errors.push('sentinel: expected an object')
    } else if (!num(value.sentinel.conversationCount) || value.sentinel.conversationCount < 0) {
      errors.push('sentinel.conversationCount: expected a non-negative number')
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, report: value as unknown as NodeStatsReport }
}

/** Machine facts attributed to a HOST rather than to an agent. */
export interface HostMachineRow {
  hostId: string
  hostname: string
  machine: MachineStats
  sampledAt: number
  /** Every agent reporting from this host, sorted. The row exists once; the
   *  agents on it are still enumerable. */
  nodeIds: string[]
  /** The agent whose sample won. */
  reportedBy: string
}

/**
 * Collapse a set of frames to ONE machine row per host.
 *
 * Two agents on one box each send the same cpu/mem/disk. Summing or listing
 * both double-counts the machine -- `studio` would appear twice at 99% disk and
 * the fleet total would claim twice the RAM that exists. The freshest sample per
 * `hostId` wins; ties break on the lexicographically smallest `nodeId` so the
 * result does not depend on the order frames happened to arrive.
 *
 * Per-node rows (which the wall keys by `nodeId`) are NOT collapsed by this --
 * it answers "what is this box doing", not "who is on it".
 */
export function dedupeMachineStatsByHost(reports: NodeStatsReport[]): HostMachineRow[] {
  const byHost = new Map<string, HostMachineRow>()
  for (const report of reports) {
    const { hostId, hostname, nodeId } = report.node
    const existing = byHost.get(hostId)
    if (!existing) {
      byHost.set(hostId, {
        hostId,
        hostname,
        machine: report.machine,
        sampledAt: report.sampledAt,
        nodeIds: [nodeId],
        reportedBy: nodeId,
      })
      continue
    }
    if (!existing.nodeIds.includes(nodeId)) existing.nodeIds.push(nodeId)
    const fresher = report.sampledAt > existing.sampledAt
    const tie = report.sampledAt === existing.sampledAt && nodeId < existing.reportedBy
    if (fresher || tie) {
      existing.machine = report.machine
      existing.sampledAt = report.sampledAt
      existing.hostname = hostname
      existing.reportedBy = nodeId
    }
  }
  for (const row of byHost.values()) row.nodeIds.sort()
  return [...byHost.values()].sort((a, b) => a.hostId.localeCompare(b.hostId))
}

/** True when `report` is old enough that a consumer must render it as stale
 *  (greyed, with a last-seen age) instead of as a live number. */
export function isNodeStatsStale(report: NodeStatsReport, now: number): boolean {
  return now - report.sampledAt > NODE_STATS_STALE_AFTER_MS
}
