/**
 * Sentinel Registry -- persisted registry of fleet nodes.
 *
 * Holds TWO credential classes (see `sentinel-registry-keys.ts`):
 *   `snt_` sentinels -- spawn authority.
 *   `rpt_` reporters -- vitals only.
 *
 * NEVER A SPAWN TARGET: every roster-shaped query here (`getAll`,
 * `findByAlias`, `getDefault`) returns SENTINELS ONLY. A reporter is reachable
 * exclusively through `findBySecret` (auth) and the explicitly named reporter
 * queries (the CLI). Excluding reporters by construction beats remembering to
 * filter them at every call site -- every existing caller of `getAll()` is a
 * spawn-routing or launch-picker surface.
 */

import { randomUUID } from 'node:crypto'
import { emptyRegistryData, readRegistryData, registryFilePath, writeRegistryData } from './sentinel-registry-file'
import {
  type CreateNodeOptions,
  generateReporterSecret,
  generateSentinelSecret,
  isReporterRecord,
  type RegistryKind,
  type SentinelRecord,
  type SentinelRecordWithId,
  type SentinelRegistryData,
} from './sentinel-registry-keys'
import {
  defaultSentinel,
  findAnyByAlias,
  findReporterByAlias,
  findSentinelByAlias,
  reporterEntries,
  sentinelEntries,
} from './sentinel-registry-queries'

export {
  type CreateNodeOptions,
  isReporterRecord,
  isReporterSecret,
  isSentinelSecret,
  isValidSentinelAlias,
  type RegistryKind,
  recordKind,
  type SentinelRecord,
  type SentinelRecordWithId,
} from './sentinel-registry-keys'

export interface SentinelRegistry {
  load(): void
  save(): void
  create(opts: CreateNodeOptions): SentinelRecordWithId & { rawSecret?: string }
  update(
    sentinelId: string,
    opts: { alias?: string; color?: string; isDefault?: boolean },
  ): SentinelRecordWithId | undefined
  get(sentinelId: string): SentinelRecord | undefined
  /** Auth lookup -- the ONE query that spans both kinds. Callers must resolve
   *  the record's kind through the capability table, never assume sentinel. */
  findBySecret(secret: string): SentinelRecordWithId | undefined
  findByAlias(alias: string): SentinelRecordWithId | undefined
  findAnyByAlias(alias: string): SentinelRecordWithId | undefined
  findReporterByAlias(alias: string): SentinelRecordWithId | undefined
  getAllReporters(): Map<string, SentinelRecord>
  getDefaultId(): string | undefined
  getDefault(): SentinelRecordWithId | undefined
  setDefault(sentinelId: string): boolean
  remove(sentinelId: string): boolean
  getAll(): Map<string, SentinelRecord>
}

export function createSentinelRegistry(cacheDir: string): SentinelRegistry {
  const filePath = registryFilePath(cacheDir)
  let data: SentinelRegistryData = emptyRegistryData()
  const secretIndex = new Map<string, string>() // secret -> nodeId

  function load(): void {
    data = readRegistryData(filePath)
    secretIndex.clear()
    for (const [id, record] of Object.entries(data.sentinels)) {
      if (record.secret) secretIndex.set(record.secret, id)
    }
  }

  function save(): void {
    writeRegistryData(cacheDir, filePath, data)
  }

  function create(opts: CreateNodeOptions): SentinelRecordWithId & { rawSecret?: string } {
    const sentinelId = randomUUID()
    const kind: RegistryKind = opts.kind === 'reporter' ? 'reporter' : 'sentinel'
    const aliases = opts.aliases || (opts.alias ? [opts.alias] : ['default'])
    // A reporter is NEVER the default node: the default IS the spawn target
    // used when a launch names no sentinel, and a reporter cannot spawn.
    const isDefault = kind === 'reporter' ? false : (opts.isDefault ?? sentinelEntries(data).length === 0)
    const record: SentinelRecord = { aliases, isDefault, color: opts.color, createdAt: Date.now() }
    if (kind === 'reporter') record.kind = 'reporter'

    let rawSecret: string | undefined
    if (opts.generateSecret) {
      rawSecret = kind === 'reporter' ? generateReporterSecret() : generateSentinelSecret()
      record.secret = rawSecret
      secretIndex.set(rawSecret, sentinelId)
    } else if (opts.secret) {
      record.secret = opts.secret
      secretIndex.set(opts.secret, sentinelId)
    }

    data.sentinels[sentinelId] = record
    if (isDefault) {
      for (const [id, r] of Object.entries(data.sentinels)) {
        if (id !== sentinelId) r.isDefault = false
      }
      data.defaultSentinelId = sentinelId
    }
    save()
    return { sentinelId, ...record, rawSecret }
  }

  function update(
    sentinelId: string,
    opts: { alias?: string; color?: string; isDefault?: boolean },
  ): SentinelRecordWithId | undefined {
    const record = data.sentinels[sentinelId]
    if (!record) return undefined
    if (opts.alias !== undefined) {
      record.aliases = [opts.alias, ...record.aliases.filter(a => a !== opts.alias)]
    }
    if (opts.color !== undefined) record.color = opts.color
    // Promoting a reporter to default would put it in the spawn path. Refused.
    if (opts.isDefault === true && !isReporterRecord(record)) {
      for (const [id, r] of Object.entries(data.sentinels)) r.isDefault = id === sentinelId
      data.defaultSentinelId = sentinelId
    }
    save()
    return { sentinelId, ...record }
  }

  function findBySecret(secret: string): SentinelRecordWithId | undefined {
    const sentinelId = secretIndex.get(secret)
    if (!sentinelId) return undefined
    const record = data.sentinels[sentinelId]
    return record ? { sentinelId, ...record } : undefined
  }

  function setDefault(sentinelId: string): boolean {
    const target = data.sentinels[sentinelId]
    if (!target || isReporterRecord(target)) return false
    for (const r of Object.values(data.sentinels)) r.isDefault = false
    target.isDefault = true
    data.defaultSentinelId = sentinelId
    save()
    return true
  }

  function remove(sentinelId: string): boolean {
    const record = data.sentinels[sentinelId]
    if (!record) return false
    if (record.secret) secretIndex.delete(record.secret)
    delete data.sentinels[sentinelId]
    if (data.defaultSentinelId === sentinelId) {
      const next = sentinelEntries(data)[0]
      data.defaultSentinelId = next?.[0]
      if (next) next[1].isDefault = true
    }
    save()
    return true
  }

  load()

  return {
    load,
    save,
    create,
    update,
    get: sentinelId => data.sentinels[sentinelId],
    findBySecret,
    findByAlias: alias => findSentinelByAlias(data, alias),
    findAnyByAlias: alias => findAnyByAlias(data, alias),
    findReporterByAlias: alias => findReporterByAlias(data, alias),
    getAllReporters: () => new Map(reporterEntries(data)),
    getDefaultId: () => data.defaultSentinelId,
    getDefault: () => defaultSentinel(data),
    setDefault,
    remove,
    getAll: () => new Map(sentinelEntries(data)),
  }
}
