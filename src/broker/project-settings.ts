/**
 * Project Settings - persistent label/icon/color per project.
 * Backed by StoreDriver KVStore (replaces JSON file persistence).
 *
 * Keys are CANONICAL project URIs produced by `projectIdentityKey()`. Bare
 * CWD inputs upgrade to URIs; profile userinfo and conversation fragments
 * collapse out so two URIs naming the same project (e.g. `claude://default/foo`
 * and `claude://work@default/foo`) share one settings entry. Without this,
 * a conversation under a non-default profile reads null for a project the
 * user has already configured.
 */

import { cwdToProjectUri, projectIdentityKey } from '../shared/project-uri'
import type { ProjectSettings } from '../shared/protocol'
import type { ScannerId } from '../shared/scanner-ids'
import { scannerEnabled } from '../shared/scanner-opt-in'
import type { KVStore } from './store/types'

export type { ProjectSettings } from '../shared/protocol'

const KV_KEY = 'project-settings'

type SettingsMap = Record<string, ProjectSettings>

let kv: KVStore | null = null
let settings: SettingsMap = {}

function normalizeKey(project: string): string {
  const upgraded = project.startsWith('/') ? cwdToProjectUri(project) : project
  return projectIdentityKey(upgraded)
}

/** Boot migration: collapse raw stored map onto canonical keys.
 *  Already-canonical entries become the base; non-canonical entries fold
 *  in without overriding existing fields on collision. Logged per collision. */
function migrateToCanonicalKeys(raw: SettingsMap): { settings: SettingsMap; migrated: boolean } {
  const out: SettingsMap = {}
  let migrated = false
  const pending: Array<{ canonicalKey: string; sourceKey: string; value: ProjectSettings }> = []
  for (const [key, value] of Object.entries(raw)) {
    const canonicalKey = normalizeKey(key)
    if (canonicalKey !== key) migrated = true
    pending.push({ canonicalKey, sourceKey: key, value })
  }
  pending.sort((a, b) => {
    const aCanon = a.sourceKey === a.canonicalKey ? 0 : 1
    const bCanon = b.sourceKey === b.canonicalKey ? 0 : 1
    return aCanon - bCanon
  })
  for (const { canonicalKey, sourceKey, value } of pending) {
    const existing = out[canonicalKey]
    if (existing) {
      out[canonicalKey] = { ...value, ...existing }
      console.log(
        `[project-settings] [migrate] collision: ${sourceKey} -> ${canonicalKey} (kept existing fields, folded in unique)`,
      )
    } else {
      out[canonicalKey] = value
      if (canonicalKey !== sourceKey) {
        console.log(`[project-settings] [migrate] ${sourceKey} -> ${canonicalKey}`)
      }
    }
  }
  return { settings: out, migrated }
}

export function initProjectSettings(store: KVStore): void {
  kv = store

  const raw = kv.get<SettingsMap>(KV_KEY)
  if (!raw) return
  try {
    const { settings: migrated, migrated: didMigrate } = migrateToCanonicalKeys(raw)
    settings = migrated
    if (didMigrate) save()
  } catch {
    settings = {}
  }
}

function save(): void {
  if (!kv) return
  kv.set(KV_KEY, settings)
}

export function getAllProjectSettings(): SettingsMap {
  return settings
}

export function getProjectSettings(project: string): ProjectSettings | null {
  return settings[normalizeKey(project)] || null
}

export function setProjectSettings(project: string, update: ProjectSettings): void {
  const key = normalizeKey(project)
  const existing = settings[key] || {}
  settings[key] = { ...existing, ...update }
  // Remove empty string values
  for (const [k, val] of Object.entries(settings[key])) {
    if (val === '' || val === undefined) {
      delete (settings[key] as Record<string, unknown>)[k]
    }
  }
  // Remove entry if empty
  if (Object.keys(settings[key]).length === 0) {
    delete settings[key]
  }
  save()
}

/**
 * May this scanner sweep this project? The store-backed spelling of
 * `scannerEnabled` -- OFF for a project that has never been configured.
 *
 * Here rather than at each call site so a caller needs one import instead of two
 * and cannot forget which of them carries the default.
 */
export function scannerEnabledForProject(project: string, id: ScannerId): boolean {
  return scannerEnabled(getProjectSettings(project), id)
}

/**
 * Stamp "this scanner just finished a pass over this project".
 *
 * NOT `setProjectSettings`, and the difference is the bug it avoids:
 * `setProjectSettings` merges SHALLOWLY, so passing `{ scannersLastRun: { epics: t } }`
 * would replace the whole map and silently erase every other scanner's stamp.
 * This merges the one key.
 *
 * Written by the CALLER that invoked the scanner, never by the scanner itself --
 * three scanners each inventing their own timestamp store is exactly the drift
 * the scanner fabric exists to end.
 */
export function stampScannerRun(project: string, id: ScannerId, at: number): void {
  const key = normalizeKey(project)
  const existing = settings[key]
  // No entry at all means the project was never configured, so no scanner can be
  // enabled on it -- stamping would conjure a settings row for a sweep that the
  // opt-in says never happened.
  if (!existing) return
  existing.scannersLastRun = { ...existing.scannersLastRun, [id]: at }
  save()
}

export function deleteProjectSettings(project: string): void {
  delete settings[normalizeKey(project)]
  save()
}
