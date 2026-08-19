/**
 * Validation helpers for the node-stats contract.
 *
 * Split out of `node-stats.ts` purely for size (a file may not cross 200 lines);
 * these are the guts of the ONE validator and have no other caller. Every check
 * pushes a REASON rather than returning a bare false, because a rejected frame
 * that does not say why is a node silently missing from the wall.
 */

import type { NodeStatsSender } from './node-stats'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Finite number check that also rejects NaN/Infinity, which JSON.parse happily
 *  produces from `null`-ish arithmetic upstream. */
export function num(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function checkIdentity(value: unknown, errors: string[]): void {
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

export function checkUsedTotal(value: unknown, path: string, errors: string[]): void {
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

export function checkLoad(value: unknown, errors: string[]): void {
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

export function checkDisk(value: unknown, errors: string[]): void {
  checkUsedTotal(value, 'machine.disk', errors)
  if (isRecord(value) && !nonEmptyString(value.mount)) {
    errors.push('machine.disk.mount: expected a non-empty string')
  }
}

export function checkMachine(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('machine: expected an object')
    return
  }
  // ABSENT IS LEGAL, and is the honest answer for a frame whose CPU delta spanned
  // no measurable window (the first tick after a sender starts). A cpuPercent
  // that is PRESENT still has to be a real percentage -- "we have no reading" is
  // spelled by leaving the key off, never by a null or a NaN.
  if (value.cpuPercent !== undefined && (!num(value.cpuPercent) || value.cpuPercent < 0 || value.cpuPercent > 100)) {
    errors.push('machine.cpuPercent: expected a number in 0..100, or absent')
  }
  checkLoad(value.load, errors)
  checkUsedTotal(value.memory, 'machine.memory', errors)
  checkDisk(value.disk, errors)
}

/**
 * The extras rule. Derived from `node.sender` rather than from who happens to be
 * calling -- the broker stamps `sender` from the CREDENTIAL before this runs, so
 * a reporter cannot claim `sender: 'sentinel'` to smuggle extras through.
 */
export function checkSentinelExtras(extras: unknown, sender: unknown, errors: string[]): void {
  if (sender === 'reporter') {
    errors.push('sentinel: sentinel-only extras are not allowed on a reporter frame')
    return
  }
  if (!isRecord(extras)) {
    errors.push('sentinel: expected an object')
    return
  }
  if (!num(extras.conversationCount) || extras.conversationCount < 0) {
    errors.push('sentinel.conversationCount: expected a non-negative number')
    return
  }
  // PROFILE-ENV BOUNDARY, held by refusal rather than by trimming: the extras
  // block is `conversationCount` and nothing else. Any other key -- `profiles`,
  // `configDir`, `env`, a token -- is a sender pushing something across that has
  // no business here, and is rejected so it shows up in the logs.
  for (const key of Object.keys(extras)) {
    if (key !== 'conversationCount') {
      errors.push(`sentinel.${key}: not allowed (the extras block is conversationCount only)`)
    }
  }
}
