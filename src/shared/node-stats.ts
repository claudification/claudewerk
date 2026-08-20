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
 * WHAT IS NOT ON THIS PAYLOAD: plan utilization, in any form. Per-profile plan
 * windows ride `sentinel_usage_report` (`ProfileUsageSnapshot` in `protocol.ts`)
 * and are read back via `getSentinelProfileUsage()`. There is exactly one
 * utilization path and this is not it -- node stats carry MACHINE facts plus the
 * conversation count. (A derived headline percent was carried here briefly and
 * removed on 2026-08-19: one number sampled on two clocks is one number that can
 * disagree with itself.)
 *
 * PROFILE-ENV BOUNDARY (`src/sentinel/sentinel-config.ts`): nothing here carries
 * a config dir, an env bag or an oauth token. The payload has no profile fields
 * at all, which is the cheapest possible way to hold that boundary.
 *
 * Split for size: the validation helpers live in `node-stats-checks.ts`, the
 * per-host views in `node-stats-host.ts`. Same contract, three files.
 */

import { checkIdentity, checkMachine, checkSentinelExtras, isRecord, num } from './node-stats-checks'

/**
 * The wire message name. A CONSTANT rather than a bare literal because three
 * places must agree on it -- the handler that registers it, the reporter
 * capability allowlist that permits exactly it, and the senders that emit it.
 * Three hand-typed strings is one typo away from a node that silently reports
 * into the void.
 */
export const NODE_STATS_MESSAGE = 'node_stats'

/**
 * The ONE HTTP ingest path. Same contract as the WS message, second transport:
 * `POST` this path with a `node_stats` frame and an `rpt_`/`snt_` bearer and it
 * runs the same validator, the same handler body and the same store.
 *
 * A CONSTANT because four places must agree on the string -- the route that
 * serves it, the `requireAuth` exception that opens it, the denial test that
 * proves it is the only one, and the shell reporter that curls it. It exists so
 * a node that should never hold a toolchain can report vitals with fifteen
 * lines of `sh` instead of a 93 MB compiled binary.
 */
export const NODE_STATS_INGEST_PATH = '/api/node-stats'

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

/**
 * One mounted volume, measured the same way `machine.disk` is.
 *
 * `mount` is IDENTITY -- a mount path is what a volume is called, in a way a
 * hostname is never what a box is called. The broker keys a `volume` stats
 * object on it and a series therefore survives a relabel, a remount and a
 * reboot.
 */
export interface VolumeStats extends UsedTotal {
  /** Absolute mount path, e.g. `/` or `/Volumes/Fint`. Identity. */
  mount: string
}

/**
 * The most volumes one frame may carry.
 *
 * A CEILING ON THE WIRE, not a display limit: every entry becomes a permanent
 * row in `stat_objects`, so a sender with a pathological mount table (a CI box
 * that mounts a thousand loopbacks) must be refused rather than absorbed. The
 * collector's own filter puts a loaded Mac at ~8, so this is a backstop that
 * should never fire. Raising it is a WIRE change: an older broker rejects a
 * frame that exceeds the number IT was built with.
 */
export const NODE_STATS_MAX_VOLUMES = 24

/** Machine facts. Per HOST -- identical for every agent on the same box. */
export interface MachineStats {
  /**
   * Whole-box CPU utilization over the last sampling interval, 0-100.
   *
   * OPTIONAL, and absent -- never zero -- when there was no interval to measure.
   * CPU is the one field here that is a DELTA rather than a point-in-time
   * reading, so the first frame after a sender starts has nothing to divide: it
   * used to ship a coin-flip 0 or 100 that S1 then filed into a 60-sample ring
   * and drew for five minutes. Same absent-vs-zero rule as
   * `SentinelNodeExtras.conversationCount`; consumers render `--`.
   */
  cpuPercent?: number
  load: LoadAverage
  memory: UsedTotal
  /**
   * The volume the agent runs on, plus the DIRECTORY it was measured at so a
   * consumer can tell `/` from an external disk. `mount` is that directory and
   * not the kernel's mount point, because the fast path reads `statfs(2)`,
   * which cannot name one -- a fallback that answered `/volume1` where every
   * other node answers a working directory would be a second meaning under one
   * field name.
   *
   * `usedBytes` is total MINUS AVAILABLE-to-an-unprivileged-writer, so the
   * root-reserved blocks count as used. Every producer computes it that way:
   * the collector via `usedFromAvailable`, `scripts/node-stats-report.sh` via
   * `($2 - $4)` on `df -Pk`. df's own `Used` column is a DIFFERENT number and
   * is never the one on the wire.
   */
  disk: UsedTotal & { mount: string }
  /**
   * EVERY mounted volume worth a series, `disk` included -- the resolution that
   * turns "this box is at 99%" into "this DISK is at 99%".
   *
   * OPTIONAL, AND THAT IS THE WHOLE VERSIONING STORY. A sender that predates the
   * field omits it and its frames stay valid; a broker that predates it ignores
   * an unknown key. No version counter, no second message name -- an additive
   * optional field is the cheapest compatible change this contract can make, and
   * `NodeStatsReport` did not need one.
   *
   * ABSENT, never `[]`, when the collector could not enumerate mounts. "We did
   * not look" and "this box has no volumes" are different facts and only one of
   * them is ever true.
   *
   * `machine.disk` IS NOT REDEFINED BY THIS. It still means the volume the agent
   * runs on, still computed by the same reader, and its `disk_percent` series
   * still means what it meant. This ADDS objects beside the node, it does not
   * re-point the node's own number.
   */
  volumes?: VolumeStats[]
}

/**
 * Facts only a SENTINEL can know. Optional on the shape and absent -- not
 * zeroed -- from a reporter frame, so "no reporter data" and "reporter with
 * nothing running" stay distinguishable.
 *
 * NO PROFILE FIELDS. Plan utilization was briefly carried here and was removed
 * (decision 2026-08-19): there is exactly ONE utilization path and it is
 * `sentinel_usage_report`. A consumer that wants a node's plan numbers joins
 * against that, rather than this payload growing a second, separately-sampled
 * copy that can disagree with it.
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
  checkMachine(value.machine, NODE_STATS_MAX_VOLUMES, errors)

  if (!num(value.sampledAt) || value.sampledAt <= 0) errors.push('sampledAt: expected a positive ms epoch')

  if (value.sentinel !== undefined) {
    checkSentinelExtras(value.sentinel, isRecord(value.node) ? value.node.sender : undefined, errors)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, report: value as unknown as NodeStatsReport }
}
// Split for size only -- these are part of the same contract and every consumer
// keeps importing them from here.
export {
  dedupeMachineStatsByHost,
  type HostMachineRow,
  isNodeStatsStale,
} from './node-stats-host'
