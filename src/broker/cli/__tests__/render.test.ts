import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Coverage } from '../../archive/list'
import type { VerifyResult } from '../../archive/types'
import type { MaintenanceReport } from '../../maintenance/types'
import { renderCoverage, renderVerify } from '../archive-render'
import { maintenanceOptionsFrom } from '../maintenance-commands'
import { renderReport } from '../maintenance-render'
import { parseArgs } from '../parse-args'

let lines: string[]
let original: typeof console.log

beforeEach(() => {
  lines = []
  original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
})

afterEach(() => {
  console.log = original
})

const out = () => lines.join('\n')

function coverage(over: Partial<Coverage> = {}): Coverage {
  return { months: [], hotRows: 0, coldRows: 0, gaps: [], ...over }
}

test('renderCoverage says so when there is nothing to show', () => {
  renderCoverage(coverage(), '/data/archives')
  expect(out()).toContain('No transcript data and no archives in /data/archives')
})

test('renderCoverage labels every hot/cold combination', () => {
  renderCoverage(
    coverage({
      months: [
        { month: '2026-03', hotRows: 0, coldRows: 500, archived: true },
        { month: '2026-04', hotRows: 10, coldRows: 20, archived: true },
        { month: '2026-05', hotRows: 0, coldRows: null, archived: false },
        { month: '2026-06', hotRows: 99, coldRows: null, archived: false },
      ],
      hotRows: 109,
      coldRows: 520,
      gaps: ['2026-05'],
    }),
    '/data/archives',
  )
  const text = out()
  expect(text).toContain('archived')
  expect(text).toContain('hot + archived')
  expect(text).toContain('GAP')
  expect(text).toContain('hot only')
  expect(text).toContain('109 rows hot, 520 rows cold')
  expect(text).toContain('GAPS (no data, no archive): 2026-05')
})

test('renderCoverage omits the gaps line when there are none', () => {
  renderCoverage(
    coverage({ months: [{ month: '2026-06', hotRows: 5, coldRows: null, archived: false }], hotRows: 5 }),
    '/a',
  )
  expect(out()).not.toContain('GAPS')
})

test('renderVerify reports a clean archive', () => {
  const result: VerifyResult = { month: '2026-06', ok: true, rows: 1234, problems: [] }
  renderVerify(result)
  expect(out()).toContain('OK: 2026-06 (1,234 rows)')
})

test('renderVerify lists every problem and the database verdict', () => {
  const result: VerifyResult = {
    month: '2026-06',
    ok: false,
    rows: 3,
    problems: ['sha256 mismatch', 'row count mismatch'],
    matchedDatabase: false,
  }
  renderVerify(result)
  const text = out()
  expect(text).toContain('FAILED: 2026-06')
  expect(text).toContain('database match: NO')
  expect(text).toContain('- sha256 mismatch')
  expect(text).toContain('- row count mismatch')
})

function report(over: Partial<MaintenanceReport> = {}): MaintenanceReport {
  return {
    startedAt: '2026-08-07T05:00:00.000Z',
    finishedAt: '2026-08-07T05:00:10.000Z',
    durationMs: 10_000,
    ok: true,
    aborted: false,
    abortReason: '',
    steps: [],
    rowsBefore: 100,
    rowsAfter: 100,
    rowsDeleted: 0,
    monthsArchived: [],
    dbBytesBefore: 8 * 1024 * 1024,
    dbBytesAfter: 8 * 1024 * 1024,
    ...over,
  }
}

test('renderReport marks each step status', () => {
  renderReport(
    report({
      steps: [
        { step: 'gate:backup', status: 'ok', detail: 'verified', durationMs: 1500 },
        { step: 'archive', status: 'skipped', detail: 'nothing aged out', durationMs: 0 },
        { step: 'smoketest', status: 'failed', detail: 'FAIL quick_check', durationMs: 0 },
      ],
    }),
  )
  const text = out()
  expect(text).toContain('PASS gate:backup (1.5s)')
  expect(text).toContain('SKIP archive')
  expect(text).toContain('FAIL smoketest')
  // Zero-duration steps must not render a bogus "(0.0s)".
  expect(text).not.toContain('archive (0.0s)')
})

test('renderReport surfaces the abort reason and archived months', () => {
  renderReport(
    report({
      ok: false,
      aborted: true,
      abortReason: 'gate:backup: no sentinel',
      monthsArchived: ['2026-03', '2026-04'],
      rowsDeleted: 42,
      rowsAfter: 58,
    }),
  )
  const text = out()
  expect(text).toContain('Maintenance FAILED')
  expect(text).toContain('ABORTED: gate:backup: no sentinel')
  expect(text).toContain('Archived: 2026-03, 2026-04')
  expect(text).toContain('Rows:    100 -> 58')
  expect(text).toContain('Deleted: 42')
})

test('maintenanceOptionsFrom applies the safety defaults', () => {
  const args = parseArgs(['maintain'], '/tmp/cache')
  const opts = maintenanceOptionsFrom(args)
  expect(opts.hotDays).toBe(90)
  expect(opts.maxBackupAgeMinutes).toBe(90)
  expect(opts.confirmDelete).toBe(false)
  expect(opts.dryRun).toBe(false)
  expect(opts.healthUrl).toBeUndefined()
})

test('maintenanceOptionsFrom honours explicit flags', () => {
  const args = parseArgs(
    [
      'maintain',
      '--hot-days',
      '30',
      '--max-backup-age',
      '15',
      '--confirm',
      '--skip-vacuum',
      '--health-url',
      'http://x/health',
    ],
    '/tmp/cache',
  )
  const opts = maintenanceOptionsFrom(args)
  expect(opts.hotDays).toBe(30)
  expect(opts.maxBackupAgeMinutes).toBe(15)
  expect(opts.confirmDelete).toBe(true)
  expect(opts.skipVacuum).toBe(true)
  expect(opts.healthUrl).toBe('http://x/health')
})
