import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Coverage } from '../../archive/list'
import type { VerifyResult } from '../../archive/types'
import type { MaintenanceReport } from '../../maintenance/types'
import { searchOptionsFrom } from '../archive-commands'
import { renderCoverage, renderVerify } from '../archive-render'
import { coverageLine, truncationLine } from '../archive-search-render'
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

test('searchOptionsFrom bounds an unbounded scan by default', () => {
  const opts = searchOptionsFrom(parseArgs(['archive', 'search', 'needle'], '/tmp/cache'))
  expect(opts.query).toBe('needle')
  expect(opts.limit).toBe(50)
  expect(opts.maxSeconds).toBe(120)
  expect(opts.regex).toBe(false)
  expect(opts.caseSensitive).toBe(false)
  // No month means every archived month is in scope -- the expensive default,
  // which is why the limit and the clock above are not optional.
  expect(opts.months).toBeUndefined()
  expect(opts.conversationId).toBeUndefined()
})

test('searchOptionsFrom honours the narrowing flags', () => {
  const argv = ['archive', 'search', 'needle', '2026-04', '--regex', '--case-sensitive']
  const opts = searchOptionsFrom(
    parseArgs([...argv, '--limit', '5', '--max-seconds', '3', '--conversation', 'conv_x'], '/tmp/cache'),
  )
  expect(opts.months).toEqual(['2026-04'])
  expect(opts.conversationId).toBe('conv_x')
  expect(opts.limit).toBe(5)
  expect(opts.maxSeconds).toBe(3)
  expect(opts.regex).toBe(true)
  expect(opts.caseSensitive).toBe(true)
})

test('the coverage line always states what was scanned', () => {
  const line = coverageLine({
    query: 'needle',
    regex: false,
    hits: [],
    scannedMonths: ['2026-04', '2026-03'],
    skippedMonths: [],
    rowsScanned: 1234,
    bytesScanned: 5 * 1024 * 1024,
    elapsedMs: 2500,
    truncated: false,
    truncatedReason: '',
  })
  expect(line).toContain('0 hit(s) for "needle"')
  expect(line).toContain('scanned 2026-04, 2026-03')
  expect(line).toContain('1,234 rows')
  expect(line).toContain('2.5s')
})

test('a truncated search says so and names the months it never opened', () => {
  const result = {
    query: 'needle',
    regex: false,
    hits: [],
    scannedMonths: ['2026-04'],
    skippedMonths: ['2026-03', '2026-02'],
    rowsScanned: 10,
    bytesScanned: 10,
    elapsedMs: 10,
    truncated: true,
    truncatedReason: 'time' as const,
  }
  expect(truncationLine(result)).toBe('INCOMPLETE: ran out of time budget. NOT searched: 2026-03, 2026-02')
  expect(truncationLine({ ...result, truncatedReason: 'limit' as const })).toContain('hit the result limit')
  // A complete answer must not carry a warning line at all.
  expect(truncationLine({ ...result, truncated: false, truncatedReason: '' as const })).toBe('')
})

test('archive search takes its query positionally', () => {
  const args = parseArgs(['archive', 'search', 'the missing decision'], '/tmp/cache')
  expect(args.subCommand).toBe('search')
  expect(args.queryArg).toBe('the missing decision')
  expect(args.monthArg).toBe('')
})

test('a YYYY-MM positional narrows the month rather than becoming the query', () => {
  // `archive search foo 2026-04` must search for foo in April, not for "2026-04".
  const args = parseArgs(['archive', 'search', 'foo', '2026-04', '--regex', '--limit', '5'], '/tmp/cache')
  expect(args.queryArg).toBe('foo')
  expect(args.monthArg).toBe('2026-04')
  expect(args.regexFlag).toBe(true)
  expect(args.limitArg).toBe('5')
})

test('a query that looks like a month still lands in the month slot first', () => {
  // Documented consequence of the ordering above: to search for the literal
  // text "2026-04" you pass --month explicitly or quote it into --regex.
  const args = parseArgs(['archive', 'search', '2026-04'], '/tmp/cache')
  expect(args.monthArg).toBe('2026-04')
  expect(args.queryArg).toBe('')
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
