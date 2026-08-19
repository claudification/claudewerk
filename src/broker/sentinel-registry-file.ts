/**
 * Registry persistence: read/write `{cacheDir}/sentinel-registry.json`.
 *
 * The file holds BOTH credential classes (`snt_` sentinels and `rpt_`
 * reporters) and therefore holds live secrets -- it is written 0600, never
 * world-readable, and never served over HTTP.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureFileSync } from '../shared/secure-temp'
import type { SentinelRegistryData } from './sentinel-registry-keys'

export function registryFilePath(cacheDir: string): string {
  return join(cacheDir, 'sentinel-registry.json')
}

export function emptyRegistryData(): SentinelRegistryData {
  return { sentinels: {}, defaultSentinelId: undefined }
}

/**
 * Read the registry. A missing or corrupt file yields an empty registry rather
 * than throwing -- a broker that cannot parse its registry must still boot and
 * say so, not refuse to start.
 */
export function readRegistryData(filePath: string): SentinelRegistryData {
  try {
    if (!existsSync(filePath)) return emptyRegistryData()
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as SentinelRegistryData
    const data: SentinelRegistryData = {
      sentinels: parsed.sentinels || {},
      defaultSentinelId: parsed.defaultSentinelId,
    }
    // Legacy records carried a single `alias`; normalise to the aliases list.
    for (const record of Object.values(data.sentinels)) {
      if (!record.aliases) {
        const legacy = (record as unknown as { alias?: string }).alias
        record.aliases = legacy ? [legacy] : ['default']
      }
    }
    return data
  } catch (err) {
    console.error(`[sentinel-registry] Failed to read ${filePath}: ${err}`)
    return emptyRegistryData()
  }
}

export function writeRegistryData(cacheDir: string, filePath: string, data: SentinelRegistryData): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
    // Holds live secrets (snt_ and rpt_) -- 0600.
    writeSecureFileSync(filePath, JSON.stringify(data, null, 2))
  } catch (err) {
    console.error(`[sentinel-registry] Failed to save: ${err}`)
  }
}
