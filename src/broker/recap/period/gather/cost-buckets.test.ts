import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDriver } from '../../../store/sqlite/driver'
import type { StoreDriver } from '../../../store/types'
import { gatherCost } from './cost'
import type { PeriodScope } from './types'

const PROJECT = 'claude://default/p/buckets'
const T0 = 1_700_000_000_000

describe('gatherCost context buckets (Pillar E)', () => {
  let cacheDir: string
  let store: StoreDriver
  const scope: PeriodScope = {
    projectUris: [PROJECT],
    periodStart: T0 - 1000,
    periodEnd: T0 + 1_000_000,
    timeZone: 'UTC',
  }

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'cost-buckets-test-'))
    store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    store.init()
  })
  afterEach(() => {
    store.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  function turn(conv: string, input: number, cacheRead: number, cacheWrite: number, costUsd: number, atMs = T0): void {
    store.costs.recordTurn({
      timestamp: atMs,
      conversationId: conv,
      projectUri: PROJECT,
      account: 'a',
      orgId: '',
      model: 'anthropic/claude-opus-4.8',
      inputTokens: input,
      outputTokens: 100,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd,
      exactCost: true,
    })
  }

  it('buckets conversations by PEAK context (input + cacheRead + cacheWrite) and accumulates cost/cache-write', () => {
    // conv_small: peak context ~10k -> <100k
    turn('conv_small', 5_000, 4_000, 1_000, 0.1)
    turn('conv_small', 8_000, 1_000, 1_000, 0.1) // peak 10k
    // conv_mid: peak context ~250k -> 200-300k
    turn('conv_mid', 50_000, 190_000, 10_000, 2.0) // 250k
    turn('conv_mid', 10_000, 10_000, 0, 0.2)
    // conv_huge: peak context ~750k -> 700k+
    turn('conv_huge', 100_000, 600_000, 50_000, 9.0) // 750k

    const out = gatherCost(store, scope)
    const byBucket = new Map(out.contextBuckets.map(b => [b.bucket, b]))

    expect(byBucket.get('<100k')?.conversations).toBe(1)
    expect(byBucket.get('200-300k')?.conversations).toBe(1)
    expect(byBucket.get('700k+')?.conversations).toBe(1)
    // empty bands are omitted
    expect(byBucket.has('100-200k')).toBe(false)
    expect(byBucket.has('300-500k')).toBe(false)

    // the cost-penalty curve: the huge-context band carries the heaviest cost...
    expect(byBucket.get('700k+')?.costUsd).toBeCloseTo(9.0, 5)
    expect(byBucket.get('200-300k')?.costUsd).toBeCloseTo(2.2, 5)
    // ...and the cache-write (re-warm) tax accumulates per band
    expect(byBucket.get('700k+')?.cacheWriteTokens).toBe(50_000)
    expect(byBucket.get('200-300k')?.cacheWriteTokens).toBe(10_000)

    // ascending order by lowerTokens
    const lowers = out.contextBuckets.map(b => b.lowerTokens)
    expect(lowers).toEqual([...lowers].sort((a, b) => a - b))
  })
})
