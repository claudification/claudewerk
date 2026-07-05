/**
 * Quest Store -- path-jailed create/patch/list/get over the quest tree
 * (plan-quest-engine §4b). Pure filesystem + string work, no wire/broker/
 * conversation concepts -- mirrors project-store.ts + nightshift-store.ts. Runs
 * on the SENTINEL (lease-watcher host), so quest state works with zero live
 * agent hosts (§14 recoverability: everything re-derivable from disk).
 *
 * Serialization lives in quest-manifest.ts (manifest.md) + quest-log.ts (the
 * append-only log). This module orchestrates them + re-exports the public API
 * the sentinel handler calls.
 */

import { mkdirSync, readdirSync } from 'node:fs'
import { generatePetname } from './petname'
import { readLog } from './quest-log'
import { readManifest, writeManifest } from './quest-manifest'
import { artifactsDir, nowIso, questsRoot } from './quest-paths'
import type {
  QuestAcceptanceContract,
  QuestGate,
  QuestLogEntry,
  QuestManifest,
  QuestManifestPatch,
  QuestStatus,
  QuestTarget,
} from './quest-schema'

export { appendLogEntry, readLog } from './quest-log'
export { readManifest } from './quest-manifest'

export interface CreateQuestInput {
  project: string
  goal: string
  target?: QuestTarget
  status?: QuestStatus
  gate?: QuestGate
  contracts?: QuestAcceptanceContract[]
  /** Force a petname (tests / re-create); otherwise one is generated. */
  petname?: string
}

/** All existing quest petnames (dir names under quests/). */
export function listQuestNames(root: string): string[] {
  try {
    return readdirSync(questsRoot(root), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

/** Create a quest: generate a collision-free petname, write the manifest. */
export function createQuest(root: string, input: CreateQuestInput, nowMs: number): QuestManifest {
  const existing = new Set(listQuestNames(root))
  const petname = input.petname ?? generatePetname(name => existing.has(name))
  if (existing.has(petname)) throw new Error(`quest already exists: ${petname}`)
  const iso = nowIso(nowMs)
  const manifest: QuestManifest = {
    petname,
    project: input.project,
    goal: input.goal,
    target: input.target ?? 'pr',
    status: input.status ?? 'intake',
    gate: input.gate ?? 'pending',
    contracts: input.contracts ?? [],
    created: iso,
    updated: iso,
  }
  writeManifest(root, manifest)
  mkdirSync(artifactsDir(root, petname), { recursive: true })
  return manifest
}

/** Patch manifest fields (`update_quest`). Never touches the append-only log. */
export function patchManifest(
  root: string,
  petname: string,
  patch: QuestManifestPatch,
  nowMs: number,
): QuestManifest | null {
  const current = readManifest(root, petname)
  if (!current) return null
  const merged: QuestManifest = {
    ...current,
    goal: patch.goal ?? current.goal,
    target: patch.target ?? current.target,
    status: patch.status ?? current.status,
    gate: patch.gate ?? current.gate,
    contracts: patch.contracts ?? current.contracts,
    abortReason: patch.abortReason ?? current.abortReason,
    updated: nowIso(nowMs),
  }
  writeManifest(root, merged)
  return merged
}

/** Every quest's manifest (skips unreadable dirs). Newest-updated first. */
export function listQuests(root: string): QuestManifest[] {
  const out: QuestManifest[] = []
  for (const name of listQuestNames(root)) {
    const m = readManifest(root, name)
    if (m) out.push(m)
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated))
}

export interface QuestDetail {
  manifest: QuestManifest
  log: QuestLogEntry[]
}

export function getQuest(root: string, petname: string): QuestDetail | null {
  const manifest = readManifest(root, petname)
  if (!manifest) return null
  return { manifest, log: readLog(root, petname) }
}
