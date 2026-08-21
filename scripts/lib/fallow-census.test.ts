import { describe, expect, test } from 'bun:test'
import { buildCensus, censusTotals, parseGateScope, parseHealthFindings } from './fallow-census'
import { deltaIsClean, diffSnapshots, parseSnapshot, serializeSnapshot, toSnapshot } from './fallow-census-diff'
import { formatCensus, formatFileVerdict } from './fallow-census-format'

/**
 * REGRESSION (2026-08-21): `board-integration-fallow-debt` gen 9 read a
 * complexity finding's DISAPPEARANCE from `fallow audit` as a fix. The function
 * (`sweepBoard`, cyclomatic 24 / cognitive 43) had not changed at all -- its
 * file simply was not in the changed set, so the audit never opened it.
 *
 * The scenario below is that exact shape: a critical function in an untouched
 * file must come back marked `gateVisible: false`, never be dropped.
 */

const health = (findings: Array<Record<string, unknown>>) => ({
  summary: { files_analyzed: 3589, functions_analyzed: 44769 },
  findings,
})

const finding = (path: string, name: string, cyclomatic = 24, cognitive = 43) => ({
  path,
  name,
  line: 305,
  cyclomatic,
  cognitive,
  line_count: 139,
  severity: cyclomatic >= 20 ? 'critical' : 'moderate',
})

const brief = (files: string[], changedFilesCount = files.length) => ({
  base_ref: '32b13956202e57ef36e817923070617213fd4b6a',
  head_sha: '7ab107d3',
  changed_files_count: changedFilesCount,
  partition: { units: [{ module_dir: 'src', files }] },
})

const censusOf = (findings: Array<Record<string, unknown>>, gateFiles: string[]) =>
  buildCensus(parseHealthFindings(health(findings)), parseGateScope(brief(gateFiles)), {
    filesAnalyzed: 3589,
    functionsAnalyzed: 44769,
  })

describe('parseHealthFindings', () => {
  test('maps line_count and keeps every field', () => {
    const [row] = parseHealthFindings(health([finding('src/shared/board-sweep.ts', 'sweepBoard')]))
    expect(row).toEqual({
      path: 'src/shared/board-sweep.ts',
      name: 'sweepBoard',
      line: 305,
      cyclomatic: 24,
      cognitive: 43,
      lineCount: 139,
      severity: 'critical',
    })
  })

  test('throws on a shape it does not recognise instead of reporting zero findings', () => {
    expect(() => parseHealthFindings({ summary: {} })).toThrow(/no `findings` array/)
  })
})

describe('parseGateScope', () => {
  test('flattens partition.units into the analyzed file set', () => {
    const scope = parseGateScope(brief(['src/b.ts', 'src/a.ts']))
    expect(scope.files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(scope.baseRef).toBe('32b13956202e57ef36e817923070617213fd4b6a')
    expect(scope.changedFilesCount).toBe(2)
  })

  test('an empty changeset is legal', () => {
    expect(parseGateScope(brief([], 0)).files).toEqual([])
  })

  test('changed files with an empty partition is a schema break, not an empty scope', () => {
    expect(() => parseGateScope(brief([], 55))).toThrow(/partition.units is empty/)
  })
})

describe('buildCensus', () => {
  test('a critical function in an untouched file survives, marked invisible', () => {
    const census = censusOf(
      [finding('src/shared/board-sweep.ts', 'sweepBoard'), finding('src/broker/fire.ts', 'fireSchedule', 21, 30)],
      ['src/broker/fire.ts'],
    )
    const sweep = census.rows.find(row => row.name === 'sweepBoard')
    expect(sweep?.gateVisible).toBe(false)
    expect(census.rows.find(row => row.name === 'fireSchedule')?.gateVisible).toBe(true)
    expect(censusTotals(census)).toEqual({
      findings: 2,
      invisible: 1,
      critical: 2,
      criticalInvisible: 1,
    })
  })

  test('sorts critical before moderate, then by cyclomatic', () => {
    const census = censusOf(
      [finding('src/a.ts', 'small', 8, 9), finding('src/b.ts', 'big', 30), finding('src/c.ts', 'mid', 22)],
      [],
    )
    expect(census.rows.map(row => row.name)).toEqual(['big', 'mid', 'small'])
  })

  test('repeated anonymous names in one file get distinct keys', () => {
    const census = censusOf([finding('src/x.ts', '<arrow>'), finding('src/x.ts', '<arrow>')], [])
    expect(census.rows.map(row => row.key)).toEqual(['src/x.ts::<arrow>', 'src/x.ts::<arrow>#2'])
  })
})

describe('census drift', () => {
  const snapshotOf = (findings: Array<Record<string, unknown>>) =>
    toSnapshot(censusOf(findings, []), '2026-08-21T00:00:00Z')

  test('round-trips through parseSnapshot', () => {
    const snap = snapshotOf([finding('src/a.ts', 'f')])
    expect(parseSnapshot(JSON.parse(JSON.stringify(snap))).rows).toHaveLength(1)
  })

  test('serializes one row per line and parses back', () => {
    const snap = snapshotOf([finding('src/a.ts', 'f'), finding('src/b.ts', 'g')])
    const text = serializeSnapshot(snap)
    expect(text.split('\n').filter(line => line.startsWith('    {'))).toHaveLength(2)
    expect(parseSnapshot(JSON.parse(text))).toEqual(snap)
  })

  test('serializes an empty census without a dangling array', () => {
    expect(JSON.parse(serializeSnapshot(snapshotOf([]))).rows).toEqual([])
  })

  test('rejects a snapshot from a different version', () => {
    expect(() => parseSnapshot({ version: 99, rows: [] })).toThrow(/re-save it with --save/)
  })

  test('classifies appeared, resolved, worsened and improved', () => {
    const previous = snapshotOf([finding('src/a.ts', 'stable'), finding('src/gone.ts', 'gone')])
    const current = snapshotOf([
      finding('src/a.ts', 'stable', 31, 50),
      finding('src/new.ts', 'fresh'),
      finding('src/b.ts', 'calmer', 21, 22),
    ])
    const previousWithCalmer = snapshotOf([
      finding('src/a.ts', 'stable'),
      finding('src/gone.ts', 'gone'),
      finding('src/b.ts', 'calmer', 25, 40),
    ])
    const delta = diffSnapshots(previousWithCalmer, current)
    expect(delta.appeared.map(row => row.name)).toEqual(['fresh'])
    expect(delta.resolved.map(row => row.name)).toEqual(['gone'])
    expect(delta.worsened.map(change => change.after.name)).toEqual(['stable'])
    expect(delta.improved.map(change => change.after.name)).toEqual(['calmer'])
    expect(deltaIsClean(delta)).toBe(false)
    expect(diffSnapshots(previous, previous)).toMatchObject({ appeared: [], worsened: [] })
    expect(deltaIsClean(diffSnapshots(previous, previous))).toBe(true)
  })

  test('cyclomatic up while cognitive falls still counts as worsened', () => {
    const previous = snapshotOf([finding('src/a.ts', 'f', 20, 60)])
    const current = snapshotOf([finding('src/a.ts', 'f', 25, 10)])
    const delta = diffSnapshots(previous, current)
    expect(delta.worsened).toHaveLength(1)
    expect(delta.improved).toHaveLength(0)
  })

  test('drops line numbers so an edit above a function is not drift', () => {
    const snap = snapshotOf([finding('src/a.ts', 'f')])
    expect(snap.rows[0]).not.toHaveProperty('line')
  })
})

describe('rendering', () => {
  test('the census headline states how much the gate cannot see', () => {
    const census = censusOf([finding('src/shared/board-sweep.ts', 'sweepBoard')], ['src/other.ts'])
    const text = formatCensus(census, 25)
    expect(text).toContain('INVISIBLE : 1 of 1 (1 critical)')
    expect(text).toContain(' ! critical')
  })

  test('--file says UNMEASURED for a file outside the gate scope', () => {
    const census = censusOf([finding('src/shared/board-sweep.ts', 'sweepBoard')], ['src/other.ts'])
    const text = formatFileVerdict(census, 'src/shared/board-sweep.ts')
    expect(text).toContain('NOT in the gate scope')
    expect(text).toContain('UNMEASURED, not fixed')
    expect(text).toContain('sweepBoard')
  })

  test('--file says a missing finding means fixed when the file IS in scope', () => {
    const census = censusOf([finding('src/a.ts', 'f')], ['src/shared/board-sweep.ts'])
    const text = formatFileVerdict(census, 'src/shared/board-sweep.ts')
    expect(text).toContain('IN the gate scope')
    expect(text).toContain('whole-repo findings above threshold: 0')
  })
})
