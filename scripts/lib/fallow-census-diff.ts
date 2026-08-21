/**
 * Census snapshots and drift -- what makes a PERIODIC whole-repo complexity
 * census worth running twice.
 *
 * A raw census is 600+ rows; nobody compares two of those by eye. The snapshot
 * keeps only what drifts (path, name, the three metrics, severity) and drops
 * line numbers deliberately, so an unrelated edit above a function does not
 * show up as movement.
 *
 * Identity is `path::name` (+ `#n` for repeated names in one file), so renaming
 * a function or moving a file reads as one resolved plus one appeared. That is
 * the honest answer -- fallow gives no stable function id to do better.
 */

import type { Census, CensusRow } from './fallow-census'

export const CENSUS_SNAPSHOT_VERSION = 1

export interface SnapshotRow {
  key: string
  path: string
  name: string
  cyclomatic: number
  cognitive: number
  lineCount: number
  severity: string
}

export interface CensusSnapshot {
  version: number
  /** ISO stamp, supplied by the caller (this module stays clock-free). */
  savedAt: string
  headSha: string
  repoFilesAnalyzed: number
  rows: SnapshotRow[]
}

function snapshotRow(row: CensusRow): SnapshotRow {
  return {
    key: row.key,
    path: row.path,
    name: row.name,
    cyclomatic: row.cyclomatic,
    cognitive: row.cognitive,
    lineCount: row.lineCount,
    severity: row.severity,
  }
}

export function toSnapshot(census: Census, savedAt: string): CensusSnapshot {
  return {
    version: CENSUS_SNAPSHOT_VERSION,
    savedAt,
    headSha: census.meta.headSha,
    repoFilesAnalyzed: census.meta.repoFilesAnalyzed,
    rows: census.rows.map(snapshotRow).sort((a, b) => a.key.localeCompare(b.key)),
  }
}

/**
 * One row per line. Ordinary `JSON.stringify(x, null, 2)` spreads 638 rows over
 * 5000 lines, so a single function drifting shows up in git as a wall of moved
 * braces. Line-per-row keeps `git diff` on the snapshot readable, which is the
 * only reason to commit it at all.
 */
export function serializeSnapshot(snapshot: CensusSnapshot): string {
  const { rows, ...head } = snapshot
  const header = Object.entries(head)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(',\n')
  const body = rows.map(row => `    ${JSON.stringify(row)}`).join(',\n')
  const list = rows.length > 0 ? `[\n${body}\n  ]` : '[]'
  return `{\n${header},\n  "rows": ${list}\n}\n`
}

function asSnapshotShape(raw: unknown): CensusSnapshot {
  const snapshot = raw as Partial<CensusSnapshot> | null
  if (!snapshot || !Array.isArray(snapshot.rows)) {
    throw new Error('census snapshot has no `rows` array')
  }
  return snapshot as CensusSnapshot
}

function assertSnapshotVersion(version: unknown): void {
  if (version !== CENSUS_SNAPSHOT_VERSION) {
    throw new Error(
      `census snapshot version ${String(version)} != ${CENSUS_SNAPSHOT_VERSION} -- re-save it with --save`,
    )
  }
}

export function parseSnapshot(raw: unknown): CensusSnapshot {
  const snapshot = asSnapshotShape(raw)
  assertSnapshotVersion(snapshot.version)
  return snapshot
}

export interface CensusChange {
  before: SnapshotRow
  after: SnapshotRow
}

export interface CensusDelta {
  appeared: SnapshotRow[]
  resolved: SnapshotRow[]
  worsened: CensusChange[]
  improved: CensusChange[]
}

const worse = (before: SnapshotRow, after: SnapshotRow): boolean =>
  after.cyclomatic > before.cyclomatic || after.cognitive > before.cognitive

const better = (before: SnapshotRow, after: SnapshotRow): boolean =>
  after.cyclomatic < before.cyclomatic || after.cognitive < before.cognitive

/**
 * A function that moved in both directions (cyclomatic up, cognitive down)
 * counts as WORSENED. A regression that hides behind an improvement in the
 * other metric is still a regression.
 */
function classify(before: Map<string, SnapshotRow>, after: SnapshotRow, delta: CensusDelta): void {
  const prior = before.get(after.key)
  if (!prior) {
    delta.appeared.push(after)
    return
  }
  before.delete(after.key)
  if (worse(prior, after)) delta.worsened.push({ before: prior, after })
  else if (better(prior, after)) delta.improved.push({ before: prior, after })
}

export function diffSnapshots(previous: CensusSnapshot, current: CensusSnapshot): CensusDelta {
  const before = new Map(previous.rows.map(row => [row.key, row]))
  const delta: CensusDelta = { appeared: [], resolved: [], worsened: [], improved: [] }
  for (const after of current.rows) classify(before, after, delta)
  delta.resolved = [...before.values()]
  return delta
}

export const deltaIsClean = (delta: CensusDelta): boolean => delta.appeared.length === 0 && delta.worsened.length === 0
