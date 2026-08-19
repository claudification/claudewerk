/**
 * Registry key material + record shapes.
 *
 * TWO credential classes live in ONE registry file, distinguished by `kind` on
 * the record and by the secret prefix:
 *
 *   `snt_`  kind 'sentinel'  -- spawns processes, distributes credentials,
 *                               opens shells on that host. All-or-nothing.
 *   `rpt_`  kind 'reporter'  -- says "cpu 71%" and nothing else. WS only,
 *                               one connection, one capability.
 *
 * The lesser rung exists so a machine that should only ever report vitals can
 * join the fleet view without being handed the keys to it.
 */

import { randomBytes } from 'node:crypto'

const SENTINEL_SECRET_PREFIX = 'snt_'
const REPORTER_SECRET_PREFIX = 'rpt_'

/** What a registry record is allowed to do. Absent on legacy records, which
 *  predate reporters and are therefore sentinels. */
export type RegistryKind = 'sentinel' | 'reporter'

export function generateSentinelSecret(): string {
  return SENTINEL_SECRET_PREFIX + randomBytes(32).toString('base64url')
}

export function generateReporterSecret(): string {
  return REPORTER_SECRET_PREFIX + randomBytes(32).toString('base64url')
}

export function isSentinelSecret(secret: string): boolean {
  return secret.startsWith(SENTINEL_SECRET_PREFIX)
}

export function isReporterSecret(secret: string): boolean {
  return secret.startsWith(REPORTER_SECRET_PREFIX)
}

const ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

export function isValidSentinelAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias)
}

export interface SentinelRecord {
  aliases: string[] // first is the display alias; findByAlias matches any
  secret?: string // per-sentinel secret (Phase 1+; omitted in Phase 0 auto-registration)
  isDefault: boolean
  color?: string
  createdAt: number
  /** Credential class. ABSENT means 'sentinel' -- every record written before
   *  reporters existed is a sentinel, and back-filling the file would be a
   *  migration for no gain. Read it through `recordKind()`, never directly. */
  kind?: RegistryKind
}

export type SentinelRecordWithId = SentinelRecord & { sentinelId: string }

/** The record's credential class, defaulting legacy records to 'sentinel'. */
export function recordKind(record: SentinelRecord): RegistryKind {
  return record.kind === 'reporter' ? 'reporter' : 'sentinel'
}

export function isReporterRecord(record: SentinelRecord): boolean {
  return recordKind(record) === 'reporter'
}

export interface SentinelRegistryData {
  sentinels: Record<string, SentinelRecord>
  defaultSentinelId?: string
}

export interface CreateNodeOptions {
  alias?: string
  aliases?: string[]
  isDefault?: boolean
  color?: string
  secret?: string
  generateSecret?: boolean
  /** Credential class. Defaults to 'sentinel'. A 'reporter' is forced
   *  non-default and gets an `rpt_` secret. */
  kind?: RegistryKind
}
