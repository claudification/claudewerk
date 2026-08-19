/**
 * The ONE validator for `report_node_stats`.
 *
 * A reporter payload and a sentinel payload go through this same call -- the
 * only difference between them is that a reporter's frame carries no `sentinel`
 * block. There is no second schema, no reporter-specific parse path.
 *
 * PROFILE-ENV BOUNDARY: this rebuilds the frame field by field into a fresh
 * object, so `configDir`, `env`, `oauthToken` or any other key a misbehaving
 * sender stuffs into the JSON is dropped here and can never reach broker state.
 */

import {
  type NodeBytes,
  type NodeLoad,
  type NodeMachineStats,
  type NodeProfileUtilization,
  type NodeSentinelStats,
  REPORT_NODE_STATS,
  type ReportNodeStats,
} from './node-stats'

export type NodeStatsValidation = { ok: true; value: ReportNodeStats } | { ok: false; error: string }

function finiteNumber(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function nonEmptyString(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function validateBytes(raw: unknown): NodeBytes | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const usedBytes = finiteNumber(rec.usedBytes)
  const totalBytes = finiteNumber(rec.totalBytes)
  if (usedBytes === null || totalBytes === null || usedBytes < 0 || totalBytes < 0) return null
  return { usedBytes, totalBytes }
}

function validateLoad(raw: unknown): NodeLoad | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const avg1 = finiteNumber(rec.avg1)
  const avg5 = finiteNumber(rec.avg5)
  const avg15 = finiteNumber(rec.avg15)
  const cores = finiteNumber(rec.cores)
  if (avg1 === null || avg5 === null || avg15 === null || cores === null || cores < 1) return null
  return { avg1, avg5, avg15, cores }
}

function validateMachine(raw: unknown): NodeMachineStats | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const cpuPercent = finiteNumber(rec.cpuPercent)
  const load = validateLoad(rec.load)
  const memory = validateBytes(rec.memory)
  const diskBytes = validateBytes(rec.disk)
  const mount = nonEmptyString((rec.disk as Record<string, unknown> | undefined)?.mount, 512)
  if (cpuPercent === null || !load || !memory || !diskBytes || !mount) return null
  return { cpuPercent: clampPercent(cpuPercent), load, memory, disk: { ...diskBytes, mount } }
}

/** PROFILE-ENV BOUNDARY enforcement point: only NAME + a clamped percent
 *  survive the copy. */
function validateProfiles(raw: unknown): NodeProfileUtilization[] {
  if (!Array.isArray(raw)) return []
  const out: NodeProfileUtilization[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const name = nonEmptyString(rec.name, 63)
    if (!name) continue
    const pct = finiteNumber(rec.utilizationPercent)
    out.push(pct === null ? { name } : { name, utilizationPercent: clampPercent(pct) })
  }
  return out
}

function validateSentinelExtras(raw: unknown): NodeSentinelStats | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const rec = raw as Record<string, unknown>
  const count = finiteNumber(rec.conversationCount)
  return {
    conversationCount: count === null || count < 0 ? 0 : Math.floor(count),
    profiles: validateProfiles(rec.profiles),
  }
}

/** Validate a raw wire frame. Returns a freshly built `ReportNodeStats`, never
 *  the input object. */
// fallow-ignore-next-line complexity
export function validateNodeStats(raw: unknown): NodeStatsValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not an object' }
  const rec = raw as Record<string, unknown>
  if (rec.type !== REPORT_NODE_STATS) return { ok: false, error: `type is not ${REPORT_NODE_STATS}` }

  const nodeId = nonEmptyString(rec.nodeId, 128)
  if (!nodeId) return { ok: false, error: 'nodeId missing' }
  const hostname = nonEmptyString(rec.hostname, 253)
  if (!hostname) return { ok: false, error: 'hostname missing' }
  const platform = nonEmptyString(rec.platform, 64)
  if (!platform) return { ok: false, error: 'platform missing' }
  const agentVersion = nonEmptyString(rec.agentVersion, 64)
  if (!agentVersion) return { ok: false, error: 'agentVersion missing' }

  const uptimeSec = finiteNumber(rec.uptimeSec)
  if (uptimeSec === null || uptimeSec < 0) return { ok: false, error: 'uptimeSec invalid' }
  const sampledAt = finiteNumber(rec.sampledAt)
  if (sampledAt === null || sampledAt <= 0) return { ok: false, error: 'sampledAt invalid' }

  const machine = validateMachine(rec.machine)
  if (!machine) return { ok: false, error: 'machine block invalid' }

  const value: ReportNodeStats = {
    type: REPORT_NODE_STATS,
    nodeId,
    hostname,
    platform,
    agentVersion,
    uptimeSec: Math.floor(uptimeSec),
    sampledAt,
    machine,
  }
  const sentinel = validateSentinelExtras(rec.sentinel)
  if (sentinel) value.sentinel = sentinel
  return { ok: true, value }
}
