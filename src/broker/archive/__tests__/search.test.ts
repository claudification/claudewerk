import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportMonth } from '../export'
import { searchArchives } from '../search'
import { buildMatcher, snippetAround } from '../search-match'
import { planArchiveSearch } from '../search-plan'
import { makeStoreDb, seedMonths } from './fixture'

async function withArchives<T>(fn: (dirs: { cacheDir: string; archiveDir: string }) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'archive-search-'))
  const cacheDir = join(root, 'cache')
  const archiveDir = join(root, 'archives')
  try {
    makeStoreDb(cacheDir)
    seedMonths(cacheDir, [
      { month: '2026-03', rows: 40 },
      { month: '2026-04', rows: 40 },
    ])
    for (const month of ['2026-03', '2026-04']) {
      await exportMonth({ cacheDir, archiveDir, month })
    }
    return await fn({ cacheDir, archiveDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('finds a literal substring, newest month first', async () => {
  await withArchives(async ({ archiveDir }) => {
    const result = await searchArchives({ archiveDir, query: 'line one of entry 7' })
    expect(result.hits.length).toBe(2)
    // Newest first, so a capped search returns the most recent matches.
    expect(result.hits[0].month).toBe('2026-04')
    expect(result.hits[1].month).toBe('2026-03')
    expect(result.hits[0].snippet).toContain('line one of entry 7')
    expect(result.truncated).toBe(false)
    expect(result.scannedMonths).toEqual(['2026-04', '2026-03'])
    expect(result.skippedMonths).toEqual([])
    expect(result.rowsScanned).toBe(80)
  })
})

// REGRESSION -- the prefilter runs against the RAW ndjson line, where the
// archive stored `he said \"quoted\"`. Searching the un-escaped needle against
// that line finds nothing, so every query containing a quote, a backslash or a
// newline would have come back empty while reporting a clean full scan -- the
// worst possible answer from a search tool.
test('a query containing a quote matches the escaped line', async () => {
  await withArchives(async ({ archiveDir }) => {
    const result = await searchArchives({ archiveDir, query: 'said "quoted, with a comma"' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits[0].snippet).toContain('quoted, with a comma')
  })
})

test('a query containing a backslash matches too', async () => {
  await withArchives(async ({ archiveDir }) => {
    const result = await searchArchives({ archiveDir, query: 'backslash \\ plus unicode' })
    expect(result.hits.length).toBeGreaterThan(0)
  })
})

test('case-insensitive by default, exact when asked', async () => {
  await withArchives(async ({ archiveDir }) => {
    expect((await searchArchives({ archiveDir, query: 'LINE ONE OF ENTRY 7' })).hits.length).toBe(2)
    expect((await searchArchives({ archiveDir, query: 'LINE ONE OF ENTRY 7', caseSensitive: true })).hits.length).toBe(
      0,
    )
  })
})

test('the conversation filter narrows to one conversation', async () => {
  await withArchives(async ({ archiveDir }) => {
    const result = await searchArchives({ archiveDir, query: 'line one of entry 5', conversationId: 'conv_2026-03' })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].conversationId).toBe('conv_2026-03')
    // Both months were still READ -- the filter narrows results, not work. Say so.
    expect(result.scannedMonths).toEqual(['2026-04', '2026-03'])
  })
})

test('hitting the limit reports truncation and names the unscanned months', async () => {
  await withArchives(async ({ archiveDir }) => {
    const result = await searchArchives({ archiveDir, query: 'line one of entry', limit: 3 })
    expect(result.hits.length).toBe(3)
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe('limit')
    expect(result.scannedMonths).toEqual(['2026-04'])
    expect(result.skippedMonths).toEqual(['2026-03'])
  })
})

test('a blown time budget is reported, not swallowed', async () => {
  await withArchives(async ({ archiveDir }) => {
    // Readings: start, first month's boundary check (both inside budget), then
    // expired -- so exactly one month gets scanned and the next is skipped.
    let calls = 0
    const now = () => (calls++ < 2 ? 0 : 10_000_000)
    const result = await searchArchives({ archiveDir, query: 'line one', maxSeconds: 1, now })
    expect(result.truncated).toBe(true)
    expect(result.truncatedReason).toBe('time')
    expect(result.skippedMonths).toEqual(['2026-03'])
  })
})

test('months narrows the scan', async () => {
  await withArchives(async ({ archiveDir }) => {
    const result = await searchArchives({ archiveDir, query: 'line one of entry 1', months: ['2026-03'] })
    expect(result.scannedMonths).toEqual(['2026-03'])
    expect(result.hits.every(h => h.month === '2026-03')).toBe(true)
  })
})

test('regex mode matches against the escaped line', async () => {
  await withArchives(async ({ archiveDir }) => {
    const result = await searchArchives({ archiveDir, query: 'entry 1[0-9]', regex: true, months: ['2026-04'] })
    expect(result.hits.length).toBe(10)
    expect(result.regex).toBe(true)

    // The sharp edge, asserted rather than described: a newline in the content
    // is the two characters \ and n in the line a regex sees, so `entry 5$`
    // finds nothing while the escaped form does.
    expect((await searchArchives({ archiveDir, query: 'entry 5$', regex: true, months: ['2026-04'] })).hits).toEqual([])
    expect(
      (await searchArchives({ archiveDir, query: 'entry 5\\\\n', regex: true, months: ['2026-04'] })).hits.length,
    ).toBe(1)
  })
})

test('an empty query is refused rather than scanning everything', async () => {
  await withArchives(async ({ archiveDir }) => {
    await expect(searchArchives({ archiveDir, query: '' })).rejects.toThrow(/needs a query/)
  })
})

test('searching a directory with no archives is a clean no-op', async () => {
  const result = await searchArchives({ archiveDir: join(tmpdir(), 'definitely-not-here'), query: 'anything' })
  expect(result.hits).toEqual([])
  expect(result.scannedMonths).toEqual([])
  expect(result.bytesScanned).toBe(0)
})

test('plan costs the scan from the metas without decompressing', async () => {
  await withArchives(async ({ archiveDir }) => {
    const plan = planArchiveSearch(archiveDir)
    expect(plan.months.map(m => m.month)).toEqual(['2026-04', '2026-03'])
    expect(plan.totalRows).toBe(80)
    expect(plan.totalPlaintextBytes).toBeGreaterThan(0)
    expect(plan.totalCompressedBytes).toBeGreaterThan(0)
    expect(plan.unmeasuredMonths).toEqual([])
    expect(plan.estimatedSeconds).toBeGreaterThanOrEqual(0)
  })
})

test('the snippet window marks both cuts', () => {
  const long = `${'a'.repeat(500)} needle ${'b'.repeat(500)}`
  const snippet = snippetAround(long, buildMatcher('needle'), 40)
  expect(snippet.startsWith('...')).toBe(true)
  expect(snippet.endsWith('...')).toBe(true)
  expect(snippet).toContain('needle')
})
