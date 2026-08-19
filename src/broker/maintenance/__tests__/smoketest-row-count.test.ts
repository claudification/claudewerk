import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeStoreDb, seedMonths } from '../../archive/__tests__/fixture'
import { runSmoketest } from '../smoketest'

/** The 2026-08-14 and 2026-08-18 maintenance failures.
 *
 *  Both runs aborted on `row count ... is below the floor -- deleted too much`
 *  while having deleted NOTHING (confirm_delete=0, "SKIP delete" in the log).
 *  The database really had fewer rows at the end than at the start -- 587 fewer
 *  on 08-18 -- because clearConversation and the reaper remove transcript rows
 *  during the 264-second window the VACUUM occupies. The floor,
 *  `rowsBefore - rowsDeleted`, models only OUR deletions and treats anyone
 *  else's as corruption.
 *
 *  The cost is not a spurious red line. `smoketestPhase` aborts the run, and an
 *  abort skips every remaining step -- which is precisely why the WAL checkpoint
 *  did not run on 08-18. With CONFIRM_DELETE on, the same false alarm now lands
 *  AFTER an irreversible delete and leaves the run half-finished. */

let root: string
let cacheDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'smoke-'))
  cacheDir = join(root, 'cache')
  makeStoreDb(cacheDir)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Remove rows behind maintenance's back, the way clearConversation does. */
function clearRows(n: number): void {
  const db = new Database(join(cacheDir, 'store.db'), { strict: true })
  db.run(`DELETE FROM transcript_entries WHERE id IN (SELECT id FROM transcript_entries LIMIT ${n})`)
  db.close()
}

function rowCount(checks: Awaited<ReturnType<typeof runSmoketest>>) {
  return checks.find(c => c.name === 'row count')
}

test('tolerates a handful of rows cleared concurrently while maintenance ran', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: 10_000 }])
  // Nothing was deleted by maintenance, so the floor is the full starting count.
  const rowsBefore = 10_000
  // 08-18 lost 587 rows out of 1,257,376 -- 0.047%. Scaled to this fixture that
  // is a handful of rows; 50 keeps the same shape with room to spare.
  clearRows(50)

  const checks = await runSmoketest(cacheDir, { rowsAfter: rowsBefore, minRows: rowsBefore })

  const check = rowCount(checks)
  expect(check?.ok).toBe(true)
  expect(check?.detail).toContain('9,950')
  expect(check?.detail).toContain('concurrent-clear allowance')
})

test('still fails when the database loses an implausible number of rows', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: 10_000 }])
  clearRows(4_000) // 40% of the database gone -- that is not concurrent traffic

  const checks = await runSmoketest(cacheDir, { rowsAfter: 10_000, minRows: 10_000 })

  const check = rowCount(checks)
  expect(check?.ok).toBe(false)
  expect(check?.detail).toContain('deleted too much')
})

test('a clean run with no concurrent traffic reports the exact count', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: 500 }])

  const checks = await runSmoketest(cacheDir, { rowsAfter: 500, minRows: 500 })

  const check = rowCount(checks)
  expect(check?.ok).toBe(true)
  expect(check?.detail).toBe('500 rows')
})

test('counts the rows maintenance deleted against the allowance, not on top of it', async () => {
  seedMonths(cacheDir, [{ month: '2026-01', rows: 10_000 }])
  // Maintenance deleted 2,000; 50 more went concurrently. Floor is 8,000.
  clearRows(2_050)

  const checks = await runSmoketest(cacheDir, { rowsAfter: 8_000, minRows: 8_000 })

  expect(rowCount(checks)?.ok).toBe(true)
})
