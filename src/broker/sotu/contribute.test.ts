import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contribWeight, recordContribution } from './contribute'
import { initSotuStore, projectSlug } from './index'
import { readLiveQueue, readQueue } from './queue'
import { readState } from './state'
import type { CalloutContrib, GitScanContrib, LifecycleContrib, TurnDigestContrib } from './types'

const SLUG = 'remote-claude'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sotu-contrib-'))
  initSotuStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const callout = (over: Partial<CalloutContrib> = {}): CalloutContrib => ({
  kind: 'callout',
  convId: 'conv-a',
  ts: 1000,
  type: 'lock',
  payload: 'refactoring permissions.ts',
  weight: 'high',
  ...over,
})

test('recordContribution appends to the queue', () => {
  recordContribution(SLUG, callout())
  const q = readQueue(SLUG)
  expect(q).toHaveLength(1)
  expect(q[0]).toMatchObject({ kind: 'callout', type: 'lock', payload: 'refactoring permissions.ts' })
})

test('recordContribution bumps weighted pendingContribs', () => {
  // callout=3, lifecycle=2, git=1 -> 6 total
  const r1 = recordContribution(SLUG, callout())
  expect(r1.pendingContribs).toBe(3)
  const lifecycle: LifecycleContrib = { kind: 'lifecycle', convId: 'conv-a', ts: 1001, event: 'created' }
  const r2 = recordContribution(SLUG, lifecycle)
  expect(r2.pendingContribs).toBe(5)
  const git: GitScanContrib = { kind: 'git_scan', convId: 'conv-a', ts: 1002, git: { branches: [], scannedAt: 1002 } }
  const r3 = recordContribution(SLUG, git)
  expect(r3.pendingContribs).toBe(6)
  expect(readState(SLUG).pendingContribs).toBe(6)
})

test('contribWeight matches the design weights', () => {
  expect(contribWeight(callout())).toBe(3)
  expect(contribWeight({ kind: 'lifecycle', convId: 'c', ts: 0, event: 'ended' })).toBe(2)
  const td: TurnDigestContrib = { kind: 'turn_digest', convId: 'c', ts: 0, intent: 'x' }
  expect(contribWeight(td)).toBe(1)
  expect(contribWeight({ kind: 'git_scan', convId: 'c', ts: 0, git: { branches: [], scannedAt: 0 } })).toBe(1)
})

test('readLiveQueue drops expired entries, keeps non-expired', () => {
  const now = 10_000
  // expired: ts 1000 + ttl 500 = 1500 < now
  recordContribution(SLUG, callout({ ts: 1000, ttlMs: 500, payload: 'stale lock' }))
  // live: ts 9000 + ttl 5000 = 14000 > now
  recordContribution(SLUG, callout({ ts: 9000, ttlMs: 5000, payload: 'fresh lock' }))
  // no ttl: never expires
  recordContribution(SLUG, callout({ ts: 1, payload: 'eternal' }))

  const live = readLiveQueue(SLUG, now)
  const payloads = live.map(c => (c.kind === 'callout' ? c.payload : '')).sort()
  expect(payloads).toEqual(['eternal', 'fresh lock'])
  // the full queue still holds all three (append-only, nothing pruned).
  expect(readQueue(SLUG)).toHaveLength(3)
})

test('projectSlug is stable + canonical across calls', () => {
  const a = projectSlug('/Users/jonas/projects/remote-claude')
  const b = projectSlug('/Users/jonas/projects/remote-claude')
  expect(a).toBe(b)
  expect(a).not.toContain('/')
})
