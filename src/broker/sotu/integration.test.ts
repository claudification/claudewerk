import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BranchFabric, GitFabric } from '../../shared/protocol'
import { writeChronicle } from './chronicle'
import { recordContribution } from './contribute'
import { initSotuStore } from './index'
import { summarizeIntegration } from './integration'
import type { GitScanContrib } from './types'
import { emptyChronicle } from './types'
import { readLatestFabric } from './view'

const SLUG = 'remote-claude'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-integration-'))
  initSotuStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const branch = (over: Partial<BranchFabric> = {}): BranchFabric => ({
  branch: 'feature',
  aheadOrigin: 0,
  behindOrigin: 0,
  aheadLocal: 0,
  behindLocal: 0,
  integration: 'merge-clean',
  alerts: [],
  ...over,
})

const fabric = (branches: BranchFabric[], over: Partial<GitFabric> = {}): GitFabric => ({
  branches,
  scannedAt: 5_000,
  ...over,
})

test('summarizeIntegration counts unpushed, stalled, dirty and conflicting branches', () => {
  const summary = summarizeIntegration(
    fabric(
      [
        branch({ branch: 'a', aheadOrigin: 3 }),
        branch({ branch: 'b', aheadOrigin: 1, alerts: ['stalled'] }),
        branch({ branch: 'c', dirty: true }),
        branch({ branch: 'd', integration: 'conflicts', conflictFiles: ['src/x.ts'] }),
      ],
      { fetchedAt: 4_000 },
    ),
  )
  expect(summary).toEqual({
    unpushed: 2,
    stalled: 1,
    dirty: 1,
    conflicts: 1,
    branches: 4,
    scannedAt: 5_000,
    fetchedAt: 4_000,
  })
})

test('no snapshot yet is zeros, not a crash -- the card renders "never scanned"', () => {
  expect(summarizeIntegration(undefined).scannedAt).toBeNull()
  expect(summarizeIntegration(undefined).branches).toBe(0)
})

test('readLatestFabric prefers the reconciled chronicle snapshot over the live queue', () => {
  const scan: GitScanContrib = {
    kind: 'git_scan',
    convId: '',
    ts: 1_000,
    git: fabric([branch({ branch: 'from-queue', aheadOrigin: 1 })], { scannedAt: 1_000 }),
  }
  recordContribution(SLUG, scan)
  const chron = emptyChronicle(9_000)
  chron.git = fabric([branch({ branch: 'from-chronicle' })], { scannedAt: 9_000 })
  writeChronicle(SLUG, chron)

  expect(readLatestFabric(SLUG, 10_000)?.branches[0].branch).toBe('from-chronicle')
})

test('readLatestFabric falls back to the newest git_scan in the live queue', () => {
  recordContribution(SLUG, {
    kind: 'git_scan',
    convId: '',
    ts: 1_000,
    git: fabric([branch({ branch: 'older' })], { scannedAt: 1_000 }),
  } as GitScanContrib)
  recordContribution(SLUG, {
    kind: 'git_scan',
    convId: '',
    ts: 2_000,
    git: fabric([branch({ branch: 'newer' })], { scannedAt: 2_000 }),
  } as GitScanContrib)
  expect(readLatestFabric(SLUG, 3_000)?.branches[0].branch).toBe('newer')
})

test('a project that was never scanned reads as undefined, and triggers nothing', () => {
  // The whole point of this read path: it answers from disk. If it ever grew a
  // scan/distill trigger, a pointer moving down the project list would fire one
  // 15s sentinel round trip -- and a paid distill -- per row.
  expect(readLatestFabric('never-scanned-project', 1_000)).toBeUndefined()
})
