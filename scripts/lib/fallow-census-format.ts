/**
 * Human rendering for the whole-repo complexity census. Plain ANSI-free text:
 * it gets pasted into cards and commit messages more often than it gets read
 * in a terminal.
 */

import type { Census, CensusRow } from './fallow-census'
import { censusTotals } from './fallow-census'
import type { CensusChange, CensusDelta, SnapshotRow } from './fallow-census-diff'

const metrics = (row: { cyclomatic: number; cognitive: number; lineCount: number }): string =>
  `cy=${row.cyclomatic} cog=${row.cognitive} loc=${row.lineCount}`

const findingLine = (row: CensusRow): string =>
  `${row.severity.padEnd(8)} ${metrics(row).padEnd(26)} ${row.path}:${row.line} ${row.name}`

const censusLine = (row: CensusRow): string => `${row.gateVisible ? '   ' : ' ! '}${findingLine(row)}`

function censusHeader(census: Census): string[] {
  const totals = censusTotals(census)
  return [
    'fallow whole-repo complexity census',
    `  repo      : ${census.meta.repoFilesAnalyzed} files, ${census.meta.repoFunctionsAnalyzed} functions analyzed`,
    `  gate scope: ${census.meta.files.length} files (base ${census.meta.baseRef.slice(0, 8)}, ${census.meta.changedFilesCount} changed)`,
    `  findings  : ${totals.findings} above threshold, ${totals.critical} critical`,
    `  INVISIBLE : ${totals.invisible} of ${totals.findings} (${totals.criticalInvisible} critical) are in files the commit gate is not looking at`,
    '',
  ]
}

export function formatCensus(census: Census, top: number): string {
  const shown = census.rows.slice(0, top)
  const hidden = census.rows.length - shown.length
  return [
    ...censusHeader(census),
    `  top ${shown.length} by severity then cyclomatic ('!' = invisible to \`bun run lint:fallow\`):`,
    ...shown.map(censusLine),
    ...(hidden > 0 ? [`  ... ${hidden} more (--top N, or --json for all)`] : []),
  ].join('\n')
}

const IN_SCOPE = '  IN the gate scope -- `bun run lint:fallow` opens this file, so a missing finding means fixed.'
const OUT_OF_SCOPE =
  '  NOT in the gate scope -- the audit never opens this file. A missing finding means UNMEASURED, not fixed.'

/** `--file <path>`: the check the card asks for before calling a finding fixed. */
export function formatFileVerdict(census: Census, path: string): string {
  const rows = census.rows.filter(row => row.path === path)
  return [
    path,
    census.meta.files.includes(path) ? IN_SCOPE : OUT_OF_SCOPE,
    `  whole-repo findings above threshold: ${rows.length}`,
    ...rows.map(row => `    ${findingLine(row)}`),
  ].join('\n')
}

const changeLine = (label: string, change: CensusChange): string =>
  `  ${label} ${change.after.path}::${change.after.name}` +
  `  cy ${change.before.cyclomatic}->${change.after.cyclomatic}` +
  `  cog ${change.before.cognitive}->${change.after.cognitive}`

const plainLine = (label: string, row: SnapshotRow): string =>
  `  ${label} ${row.path}::${row.name}  ${metrics(row)}  ${row.severity}`

export function formatDelta(delta: CensusDelta, previousSavedAt: string): string {
  const body = [
    ...delta.appeared.map(row => plainLine('NEW     ', row)),
    ...delta.worsened.map(change => changeLine('WORSE   ', change)),
    ...delta.improved.map(change => changeLine('better  ', change)),
    ...delta.resolved.map(row => plainLine('resolved', row)),
  ]
  const lines = body.length > 0 ? body : ['  no movement above threshold']
  return [`census drift since ${previousSavedAt}`, ...lines].join('\n')
}
