/**
 * Quest manifest.md serializer/parser (plan-quest-engine §4b). Scalars live in
 * frontmatter; `goal` + `contracts` live in the body (`## Goal` narrative +
 * `## Acceptance` json fence) because the frontmatter subset only holds flat
 * scalars + inline string arrays. Round-trips exactly (schema-round-trip test).
 *
 * Path-jailed via quest-paths + resolveInRoot. Pure filesystem + string work.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { parseFrontmatter, serializeFrontmatter } from './frontmatter'
import { resolveInRoot } from './project-store'
import { manifestFile, questDir } from './quest-paths'
import {
  asQuestGate,
  asQuestStatus,
  asQuestTarget,
  type QuestAcceptanceContract,
  type QuestManifest,
} from './quest-schema'

function manifestFrontmatter(m: QuestManifest): Record<string, unknown> {
  return {
    petname: m.petname,
    project: m.project,
    target: m.target,
    status: m.status,
    gate: m.gate,
    abortReason: m.abortReason,
    created: m.created,
    updated: m.updated,
  }
}

function manifestBody(goal: string, contracts: QuestAcceptanceContract[]): string {
  return [
    '## Goal',
    '',
    goal.trim() || '_no goal_',
    '',
    '## Acceptance',
    '',
    '```json',
    JSON.stringify(contracts, null, 2),
    '```',
  ].join('\n')
}

/** Text of the `## <heading>` section up to the next `## ` (or end). */
function extractSection(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}`)
  if (start === -1) return ''
  const after = start + `## ${heading}`.length
  const rest = body.slice(after)
  const next = rest.indexOf('\n## ')
  return (next === -1 ? rest : rest.slice(0, next)).trim()
}

function parseContracts(body: string): QuestAcceptanceContract[] {
  const m = body.match(/```json\n([\s\S]*?)\n```/)
  if (!m) return []
  try {
    const parsed = JSON.parse(m[1])
    return Array.isArray(parsed) ? (parsed as QuestAcceptanceContract[]) : []
  } catch {
    return []
  }
}

function coerceManifest(meta: Record<string, unknown>, body: string, petname: string): QuestManifest {
  const goalSection = extractSection(body, 'Goal').replace(/^_no goal_$/, '')
  return {
    petname: (meta.petname as string) || petname,
    project: (meta.project as string) || '',
    goal: goalSection,
    target: asQuestTarget(meta.target),
    status: asQuestStatus(meta.status),
    gate: asQuestGate(meta.gate),
    contracts: parseContracts(body),
    abortReason: (meta.abortReason as string) || undefined,
    created: (meta.created as string) || '',
    updated: (meta.updated as string) || '',
  }
}

export function writeManifest(root: string, m: QuestManifest): void {
  mkdirSync(questDir(root, m.petname), { recursive: true })
  const file = manifestFile(root, m.petname)
  resolveInRoot(root, file.slice(root.length)) // path-jail belt-and-suspenders
  writeFileSync(file, serializeFrontmatter(manifestFrontmatter(m), manifestBody(m.goal, m.contracts)), 'utf8')
}

export function readManifest(root: string, petname: string): QuestManifest | null {
  const file = manifestFile(root, petname)
  if (!existsSync(file)) return null
  try {
    const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'))
    return coerceManifest(meta, body, petname)
  } catch {
    return null
  }
}
