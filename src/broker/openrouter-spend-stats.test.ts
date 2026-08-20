/**
 * The card's acceptance test: money lands in THE STATS TABLE, keyed by feature,
 * off the ONE sink -- and no failure of that filing can reach `chat()`.
 *
 * These go through the real store on a temp directory rather than a mock,
 * because what is being proved is what ends up in `stat_objects`: one row per
 * feature, on the pinned broker node, with no invented identity. The sink tests
 * go through the real `chat()` for the same reason `openrouter-spend-store.test`
 * does -- the contract is that this happens inside `recordOpenRouterSpend()` and
 * NO call site changed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATS_BROKER_NODE_ID } from '../shared/stats'
import { recordOpenRouterSpendStats } from './openrouter-spend-stats'
import type { OpenRouterSpendRecord } from './openrouter-spend-store'
import { chat } from './recap/shared/openrouter-client'
import type { NormalizedUsage } from './recap/shared/pricing'
import { readStatsByKind } from './stats/read'
import { closeStatsStore, flushStats, initStatsStore } from './stats/store'

/** Relative to the real clock: `initStatsStore()` sweeps against `Date.now()`,
 *  so a hard-coded epoch would be retention-swept before it could be read back. */
const AT = Date.now() - 60_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'or-spend-stats-test-'))
  initStatsStore(dir)
})
afterEach(() => {
  closeStatsStore()
  rmSync(dir, { recursive: true, force: true })
})

function usage(over: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.004,
    costSource: 'openrouter',
    ...over,
  }
}

function spent(feature: string, costUsd: number, at = AT): void {
  recordOpenRouterSpendStats(
    { feature, model: 'anthropic/claude-haiku-4-5', ms: 500, ok: true, usage: usage({ costUsd }) },
    at,
  )
}

function spendSeries() {
  return readStatsByKind('feature', 'spend_usd', 0)
}

/** Silence the sink's own `[openrouter]` line and any swallowed-error report, so
 *  a passing run is quiet. Returns whatever `console.error` was told. */
async function quietly<T>(run: () => Promise<T> | T): Promise<{ result?: T; err?: unknown; errors: string[] }> {
  const errors: string[] = []
  const log = console.log
  const error = console.error
  console.log = () => {}
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  }
  try {
    return { result: await run(), errors }
  } catch (err) {
    return { err, errors }
  } finally {
    console.log = log
    console.error = error
  }
}

describe('the feature object', () => {
  test('is the feature name on the pinned broker node, with no label', () => {
    spent('desk-agent', 0.004)
    flushStats()

    const series = spendSeries()
    expect(series).toHaveLength(1)
    // No `label`: a feature has no display alias distinct from its key, and
    // writing one would be the key twice.
    expect(series[0]?.ref).toEqual({ nodeId: STATS_BROKER_NODE_ID, kind: 'feature', name: 'desk-agent' })
    expect(series[0]?.points).toEqual([{ ts: AT, value: 0.004 }])
  })

  test('two features are two series; one feature accumulates instead of forking', () => {
    spent('desk-agent', 0.01)
    spent('desk-agent', 0.02, AT + 5_000)
    spent('recap-period', 0.5)
    flushStats()

    const series = spendSeries()
    expect(series.map(s => s.ref.name).sort()).toEqual(['desk-agent', 'recap-period'])
    expect(series.find(s => s.ref.name === 'desk-agent')?.points.map(p => p.value)).toEqual([0.01, 0.02])
  })
})

describe('what is filed and what is not', () => {
  test('a failed call files NOTHING -- its cost is unknowable, and 0 would be a claim', () => {
    recordOpenRouterSpendStats(
      { feature: 'voice-refiner', model: 'gemma', ms: 30_000, ok: false, error: 'Timeout' },
      AT,
    )
    flushStats()

    // The failure accounting that IS knowable (the call happened, it burnt 30s)
    // lives in `openrouter-spend.db`, which this does not retire.
    expect(spendSeries()).toEqual([])
  })

  test('a free model files its measured $0 -- that zero is a reading, not a gap', () => {
    spent('classifier', 0)
    flushStats()

    expect(spendSeries()[0]?.points).toEqual([{ ts: AT, value: 0 }])
  })
})

describe('the sink', () => {
  function fetcherReturning(res: () => Response): typeof fetch {
    return (async () => res()) as unknown as typeof fetch
  }

  const OK_BODY = JSON.stringify({
    choices: [{ message: { content: 'hi' } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.004 },
    model: 'anthropic/claude-haiku-4-5',
  })

  test('a successful chat() files spend against its feature -- no second call site', async () => {
    await quietly(() =>
      chat({
        feature: 'desk-agent',
        model: 'anthropic/claude-haiku-4-5',
        user: 'x',
        apiKey: 'k_test',
        fetcher: fetcherReturning(() => new Response(OK_BODY, { status: 200 })),
      }),
    )
    flushStats()

    const series = spendSeries()
    expect(series).toHaveLength(1)
    expect(series[0]?.ref.name).toBe('desk-agent')
    expect(series[0]?.points[0]?.value).toBe(0.004)
  })

  // ─── Done #3: spend accounting may never fail a chat() call ────────

  test('a failed chat() still rejects with the PROVIDER error, and files no spend', async () => {
    const { err } = await quietly(() =>
      chat({
        feature: 'voice-refiner',
        model: 'google/gemma-4-31b',
        user: 'x',
        apiKey: 'k_test',
        retries: 0,
        fetcher: fetcherReturning(() => new Response('bad model', { status: 400 })),
      }),
    )
    flushStats()

    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).toContain('bad model')
    expect(spendSeries()).toEqual([])
  })

  test('chat() is unaffected when the stats store was never initialized', async () => {
    closeStatsStore()
    const { result, err } = await quietly(() =>
      chat({
        feature: 'desk-agent',
        model: 'anthropic/claude-haiku-4-5',
        user: 'x',
        apiKey: 'k_test',
        fetcher: fetcherReturning(() => new Response(OK_BODY, { status: 200 })),
      }),
    )

    expect(err).toBeUndefined()
    expect(result?.content).toBe('hi')
  })

  test('a producer that throws is swallowed and logged, never raised at the caller', async () => {
    // Nothing in the real path throws -- `recordStat` buffers and `flushStats`
    // has its own catch -- so the failure is forced through a record that
    // explodes when read. The point is that the guard is there: this function is
    // called from inside `chat()`'s try, so an escaping throw would be reported
    // to the caller as a failed LLM call.
    const exploding = {
      get ok(): boolean {
        throw new Error('boom')
      },
    } as unknown as OpenRouterSpendRecord

    const { errors } = await quietly(() => {
      recordOpenRouterSpendStats(exploding, AT)
    })
    expect(errors.some(l => l.includes('Spend stat failed') && l.includes('boom'))).toBe(true)
  })
})
