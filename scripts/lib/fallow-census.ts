/**
 * Whole-repo complexity census -- the pure half of `scripts/fallow-census.ts`.
 *
 * WHY IT EXISTS (2026-08-21): `bun run lint:fallow` (= `fallow audit`) reports
 * complexity for the CHANGED FILE SET ONLY. A critical function in a file that
 * has not been touched since the merge-base is not reported as `introduced:
 * false` -- it is not reported AT ALL. "The finding went away" and "nobody
 * opened that file" produce byte-identical audit output.
 *
 * Measured at 7ab107d3: the audit analyzed 53 files / 1240 functions and found
 * 40 above threshold. `fallow health` over the same tree analyzed 3589 files /
 * 44769 functions and found 638. `sweepBoard` (cyclomatic 24, cognitive 43,
 * 139 lines, severity critical) sat in the second number and not the first,
 * purely because `src/shared/board-sweep.ts` was not in the diff. It has since
 * been split (324c58f8) -- and this tool is how you tell that apart from the
 * audit merely having stopped looking.
 *
 * This module joins the two runs so every finding carries `gateVisible`: can
 * the commit gate see this function right now, yes or no.
 *
 * Every function here stays under cyclomatic 5 on purpose. Nothing under
 * `scripts/` has coverage in fallow's estimator, and CRAP with zero coverage is
 * `cy + cy^2`, so cyclomatic 5 alone hits the CRAP-30 threshold and fails the
 * gate. See docs/fallow-audit-scope.md.
 */

export interface HealthFinding {
  path: string
  name: string
  line: number
  cyclomatic: number
  cognitive: number
  lineCount: number
  severity: string
}

export interface CensusRow extends HealthFinding {
  /** false = `bun run lint:fallow` is silent about this function today. */
  gateVisible: boolean
  /** Stable-ish identity across line drift: `path::name` (+ `#n` for repeats). */
  key: string
}

export interface GateScope {
  baseRef: string
  headSha: string
  changedFilesCount: number
  /** The files the audit's complexity pass actually opened. */
  files: string[]
}

export interface CensusMeta extends GateScope {
  repoFilesAnalyzed: number
  repoFunctionsAnalyzed: number
}

export interface Census {
  meta: CensusMeta
  rows: CensusRow[]
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, moderate: 2 }

const rank = (severity: string): number => SEVERITY_RANK[severity] ?? 3

export const finiteNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object') throw new Error(`${what} is not an object`)
  return raw as Record<string, unknown>
}

function toFinding(raw: unknown): HealthFinding {
  const finding = raw as Record<string, unknown>
  return {
    path: text(finding.path, '<unknown>'),
    name: text(finding.name, '<anonymous>'),
    line: finiteNumber(finding.line),
    cyclomatic: finiteNumber(finding.cyclomatic),
    cognitive: finiteNumber(finding.cognitive),
    lineCount: finiteNumber(finding.line_count),
    severity: text(finding.severity, 'unknown'),
  }
}

/**
 * Read `fallow health --format json`. Throws rather than returning [] on a
 * shape it does not recognise: a silently-empty census is the exact failure
 * this whole file exists to prevent.
 */
export function parseHealthFindings(raw: unknown): HealthFinding[] {
  const findings = asObject(raw, 'fallow health JSON').findings
  if (!Array.isArray(findings)) {
    throw new Error('fallow health JSON has no `findings` array -- schema changed?')
  }
  return findings.map(toFinding)
}

function partitionUnits(root: Record<string, unknown>): unknown[] {
  const partition = asObject(root.partition ?? {}, 'fallow audit partition')
  return Array.isArray(partition.units) ? partition.units : []
}

function unitFiles(unit: unknown): string[] {
  const files = (unit as { files?: unknown }).files
  return Array.isArray(files) ? files.filter(file => typeof file === 'string') : []
}

function analyzedFiles(root: Record<string, unknown>): string[] {
  const files = new Set<string>()
  for (const unit of partitionUnits(root)) {
    for (const file of unitFiles(unit)) files.add(file)
  }
  return [...files].sort()
}

function assertScopeCoherent(changedFilesCount: number, analyzed: number): void {
  if (changedFilesCount > 0 && analyzed === 0) {
    throw new Error(
      `fallow audit reports ${changedFilesCount} changed files but partition.units is empty -- schema changed?`,
    )
  }
}

/**
 * Read `fallow audit --brief --format json`. `partition.units[].files[]` is
 * fallow's own answer to "which files did I open", so the gate's scope is
 * never re-derived here from `git diff` -- base resolution stays fallow's job.
 */
export function parseGateScope(raw: unknown): GateScope {
  const root = asObject(raw, 'fallow audit JSON')
  const files = analyzedFiles(root)
  const changedFilesCount = finiteNumber(root.changed_files_count)
  assertScopeCoherent(changedFilesCount, files.length)
  return {
    baseRef: text(root.base_ref, 'unknown'),
    headSha: text(root.head_sha, 'unknown'),
    changedFilesCount,
    files,
  }
}

/** `path::name`, with `#2`, `#3` ... for repeated names in one file. */
function assignKeys(findings: HealthFinding[]): string[] {
  const seen = new Map<string, number>()
  const keys: string[] = []
  for (const finding of findings) {
    const base = `${finding.path}::${finding.name}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    keys.push(n === 1 ? base : `${base}#${n}`)
  }
  return keys
}

const bySeverityThenSize = (a: CensusRow, b: CensusRow): number =>
  rank(a.severity) - rank(b.severity) ||
  b.cyclomatic - a.cyclomatic ||
  b.cognitive - a.cognitive ||
  a.key.localeCompare(b.key)

export function buildCensus(
  findings: HealthFinding[],
  scope: GateScope,
  repo: { filesAnalyzed: number; functionsAnalyzed: number },
): Census {
  const gateFiles = new Set(scope.files)
  const keys = assignKeys(findings)
  const rows: CensusRow[] = findings.map((finding, i) => ({
    ...finding,
    gateVisible: gateFiles.has(finding.path),
    key: keys[i],
  }))
  return {
    meta: {
      ...scope,
      repoFilesAnalyzed: repo.filesAnalyzed,
      repoFunctionsAnalyzed: repo.functionsAnalyzed,
    },
    rows: rows.sort(bySeverityThenSize),
  }
}

export interface CensusTotals {
  findings: number
  invisible: number
  critical: number
  criticalInvisible: number
}

const isInvisible = (row: CensusRow): boolean => !row.gateVisible
const isCritical = (row: CensusRow): boolean => row.severity === 'critical'

export function censusTotals(census: Census): CensusTotals {
  const critical = census.rows.filter(isCritical)
  return {
    findings: census.rows.length,
    invisible: census.rows.filter(isInvisible).length,
    critical: critical.length,
    criticalInvisible: critical.filter(isInvisible).length,
  }
}
