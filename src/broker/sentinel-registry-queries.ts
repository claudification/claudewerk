/**
 * Pure read queries over the registry data.
 *
 * The kind split lives HERE, in one file, so the factory cannot accidentally
 * hand a reporter to a spawn-routing caller: the roster-shaped queries
 * (`sentinelEntries`, `findSentinelByAlias`, `defaultSentinel`) filter reporters
 * out by construction, and reaching a reporter takes an explicitly named
 * function.
 */

import {
  isReporterRecord,
  type SentinelRecord,
  type SentinelRecordWithId,
  type SentinelRegistryData,
} from './sentinel-registry-keys'

/** SENTINELS ONLY. The spawn roster / launch picker reads this. */
export function sentinelEntries(data: SentinelRegistryData): Array<[string, SentinelRecord]> {
  return Object.entries(data.sentinels).filter(([, record]) => !isReporterRecord(record))
}

export function reporterEntries(data: SentinelRegistryData): Array<[string, SentinelRecord]> {
  return Object.entries(data.sentinels).filter(([, record]) => isReporterRecord(record))
}

export function findSentinelByAlias(data: SentinelRegistryData, alias: string): SentinelRecordWithId | undefined {
  for (const [sentinelId, record] of sentinelEntries(data)) {
    if (record.aliases.includes(alias)) return { sentinelId, ...record }
  }
  return undefined
}

/** Alias uniqueness across BOTH kinds, so a reporter cannot shadow a sentinel
 *  name (or vice versa) at creation time. */
export function findAnyByAlias(data: SentinelRegistryData, alias: string): SentinelRecordWithId | undefined {
  for (const [sentinelId, record] of Object.entries(data.sentinels)) {
    if (record.aliases.includes(alias)) return { sentinelId, ...record }
  }
  return undefined
}

export function findReporterByAlias(data: SentinelRegistryData, alias: string): SentinelRecordWithId | undefined {
  for (const [sentinelId, record] of reporterEntries(data)) {
    if (record.aliases.includes(alias)) return { sentinelId, ...record }
  }
  return undefined
}

/** The default SPAWN TARGET. A reporter pointed at by `defaultSentinelId`
 *  (which `create`/`setDefault` refuse to write) resolves to undefined rather
 *  than to a node that cannot spawn. */
export function defaultSentinel(data: SentinelRegistryData): SentinelRecordWithId | undefined {
  const id = data.defaultSentinelId
  if (!id) return undefined
  const record = data.sentinels[id]
  if (!record || isReporterRecord(record)) return undefined
  return { sentinelId: id, ...record }
}
