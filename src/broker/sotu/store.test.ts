import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendContribution,
  type CalloutContrib,
  type Chronicle,
  emptyChronicle,
  emptyState,
  FLEET_SLUG,
  initSotuStore,
  isExpired,
  type LifecycleContrib,
  projectDir,
  readChronicle,
  readChronicleMd,
  readLiveQueue,
  readQueue,
  readState,
  renderChronicleMd,
  SOTU_PIPELINE_VERSION,
  sanitizeSlug,
  sotuRootDir,
  updateState,
  writeChronicle,
  writeState,
} from './index'

const SLUG = 'remote-claude'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-test-'))
  initSotuStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function callout(over: Partial<CalloutContrib> = {}): CalloutContrib {
  return { kind: 'callout', type: 'insight', payload: 'p', weight: 'high', convId: 'c1', ts: 1000, ...over }
}

// ─── paths / slug ───────────────────────────────────────────────────

test('sotuRootDir resolves under the cache dir', () => {
  expect(sotuRootDir()).toBe(join(dir, 'sotu'))
})

test('projectDir creates the per-project dir', () => {
  const p = projectDir(SLUG)
  expect(p).toBe(join(dir, 'sotu', SLUG))
  expect(existsSync(p)).toBe(true)
})

test('sanitizeSlug strips path-unsafe chars and the reserved underscore prefix', () => {
  expect(sanitizeSlug('My Project!')).toBe('my-project-')
  expect(sanitizeSlug('_fleet')).toBe('fleet') // cannot alias the reserved rollup slug
  expect(sanitizeSlug('')).toBe('unknown')
  expect(sanitizeSlug('..')).toBe('unknown')
})

test('FLEET_SLUG keeps its leading underscore (reserved rollup dir)', () => {
  expect(projectDir(FLEET_SLUG)).toBe(join(dir, 'sotu', '_fleet'))
})

// ─── queue ──────────────────────────────────────────────────────────

test('readQueue is empty before any append', () => {
  expect(readQueue(SLUG)).toEqual([])
})

test('appendContribution is append-only and preserves order', () => {
  const a = callout({ ts: 1 })
  const b: LifecycleContrib = { kind: 'lifecycle', event: 'ended', convId: 'c2', ts: 2 }
  appendContribution(SLUG, a)
  appendContribution(SLUG, b)
  expect(readQueue(SLUG)).toEqual([a, b])
})

test('readQueue skips a torn/partial JSONL line at EOF', () => {
  appendContribution(SLUG, callout({ convId: 'good' }))
  // simulate a crash mid-append: a partial trailing line (no newline, invalid json)
  const { appendFileSync } = require('node:fs')
  appendFileSync(join(dir, 'sotu', SLUG, 'queue.jsonl'), '{ broken json torn at eof')
  const q = readQueue(SLUG)
  expect(q).toHaveLength(1)
  expect(q[0].convId).toBe('good')
})

test('isExpired honors ttlMs and treats no-ttl as eternal', () => {
  expect(isExpired(callout({ ts: 0, ttlMs: 100 }), 50)).toBe(false)
  expect(isExpired(callout({ ts: 0, ttlMs: 100 }), 200)).toBe(true)
  expect(isExpired(callout({ ts: 0 }), 1e12)).toBe(false)
})

test('readLiveQueue returns only non-expired contributions', () => {
  appendContribution(SLUG, callout({ convId: 'live', ts: 0, ttlMs: 1000 }))
  appendContribution(SLUG, callout({ convId: 'dead', ts: 0, ttlMs: 10 }))
  appendContribution(SLUG, callout({ convId: 'eternal', ts: 0 }))
  const live = readLiveQueue(SLUG, 500).map(c => c.convId)
  expect(live).toEqual(['live', 'eternal'])
})

// ─── chronicle ──────────────────────────────────────────────────────

test('readChronicle returns an empty chronicle before any write', () => {
  expect(readChronicle(SLUG)).toEqual(emptyChronicle())
  expect(readChronicleMd(SLUG)).toBeNull()
})

test('writeChronicle round-trips json and writes a markdown render', () => {
  const c: Chronicle = {
    now: [{ convId: 'c1', title: 'auth', detail: 'refactoring permissions.ts', ts: 5 }],
    justDone: [{ convId: 'c2', detail: 'shipped sheaf fix', ts: 4 }],
    narrative: 'Two convs active, one landed.',
    pipelineVersion: SOTU_PIPELINE_VERSION,
    generatedAt: 123,
  }
  writeChronicle(SLUG, c)
  expect(readChronicle(SLUG)).toEqual(c)
  const md = readChronicleMd(SLUG)
  expect(md).toContain('# State of the Union')
  expect(md).toContain('Two convs active, one landed.')
  expect(md).toContain('**auth** -- refactoring permissions.ts')
  expect(md).toContain('shipped sheaf fix')
})

test('renderChronicleMd omits empty sections', () => {
  const md = renderChronicleMd(emptyChronicle())
  expect(md).toBe('# State of the Union\n')
})

// ─── state ──────────────────────────────────────────────────────────

test('readState returns empty state before any write', () => {
  expect(readState(SLUG)).toEqual(emptyState())
})

test('writeState / readState round-trip', () => {
  const s = { lastDistillAt: 10, pendingContribs: 7, genAt: 9, pipelineVersion: SOTU_PIPELINE_VERSION }
  writeState(SLUG, s)
  expect(readState(SLUG)).toEqual(s)
})

test('updateState applies the mutation and persists it', () => {
  updateState(SLUG, s => ({ ...s, pendingContribs: s.pendingContribs + 3 }))
  expect(readState(SLUG).pendingContribs).toBe(3)
  updateState(SLUG, s => ({ ...s, pendingContribs: s.pendingContribs + 3 }))
  expect(readState(SLUG).pendingContribs).toBe(6)
})

test('readState resets a stale-pipeline state to empty (replay gate)', () => {
  writeState(SLUG, { lastDistillAt: 1, pendingContribs: 99, genAt: 1, pipelineVersion: SOTU_PIPELINE_VERSION + 1 })
  expect(readState(SLUG)).toEqual(emptyState())
})
