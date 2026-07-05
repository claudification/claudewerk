/**
 * Quest tree layout (plan-quest-engine §4b) -- the single source of truth for
 * where a quest's files live under `<project>/.rclaude/project/quests/<petname>/`.
 * Pure path math; shared by quest-manifest.ts, quest-log.ts, quest-store.ts.
 */

import { join } from 'node:path'
import { isValidPetname } from './petname'

export function questsRoot(root: string): string {
  return join(root, '.rclaude', 'project', 'quests')
}
export function questDir(root: string, petname: string): string {
  return join(questsRoot(root), safePetname(petname))
}
export function manifestFile(root: string, petname: string): string {
  return join(questDir(root, petname), 'manifest.md')
}
export function logFile(root: string, petname: string): string {
  return join(questDir(root, petname), 'log.md')
}
export function artifactsDir(root: string, petname: string): string {
  return join(questDir(root, petname), 'artifacts')
}

/** Petnames are validated lowercase-hyphen handles; reject anything else as a
 *  path segment (belt-and-suspenders against traversal). */
function safePetname(petname: string): string {
  if (!isValidPetname(petname)) throw new Error(`invalid petname: ${petname}`)
  return petname
}

export function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString()
}
