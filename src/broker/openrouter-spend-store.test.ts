import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeOpenRouterSpendStore,
  initOpenRouterSpendStore,
  type OpenRouterSpendRecord,
  querySpendRollup,
  recordSpend,
  trimOpenRouterSpend,
} from './openrouter-spend-store'
import { chat } from './recap/shared/openrouter-client'
import type { NormalizedUsage } from './recap/shared/pricing'

const NOW = 1_760_000_000_000 // fixed clock: every window assertion is exact
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'or-spend-test-'))
  initOpenRouterSpendStore(dir)
})
afterEach(() => {
  closeOpenRouterSpendStore()
  rmSync(dir, { recursive: true, force: true })
})

function usage(over: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
    costSource: 'openrouter',
    ...over,
  }
}

function ok(feature: string, model: string, over: Partial<OpenRouterSpendRecord> = {}, at = NOW): void {
  recordSpend({ feature, model, ms: 500, ok: true, usage: usage(), ...over }, at)
}

function failed(feature: string, model: string, ms: number, at = NOW): void {
  recordSpend({ feature, model, ms, ok: false, error: 'TimeoutError' }, at)
}

// ─── The sink ───────────────────────────────────────────────────────
// These go through chat() on purpose: the card's contract is that persistence
// happens inside recordOpenRouterSpend() and NO call site changed.

function fetcherReturning(res: () => Response): typeof fetch {
  return (async () => res()) as unknown as typeof fetch
}

function captureLog<T>(run: () => Promise<T>): Promise<{ result: T | undefined; lines: string[]; err?: unknown }> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  return run()
    .then(result => ({ result, lines }))
    .catch(err => ({ result: undefined, lines, err }))
    .finally(() => {
      console.log = original
    })
}

describe('the sink', () => {
  test('a successful chat() lands one row AND still prints the [openrouter] line', async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.004 },
      model: 'anthropic/claude-haiku-4-5',
    })
    const { lines } = await captureLog(() =>
      chat({
        feature: 'desk-agent',
        model: 'anthropic/claude-haiku-4-5',
        user: 'x',
        apiKey: 'k_test',
        fetcher: fetcherReturning(() => new Response(body, { status: 200 })),
      }),
    )

    const spendLine = lines.find(l => l.startsWith('[openrouter] '))
    expect(spendLine).toBeDefined()
    expect(spendLine).toContain('feature=desk-agent model=anthropic/claude-haiku-4-5')
    expect(spendLine).toContain('ok=true')
    expect(spendLine).toContain('in=100 out=20')
    expect(spendLine).toContain('cost=$0.004000 src=openrouter')

    const rollup = querySpendRollup('24h', undefined, Date.now())
    expect(rollup.byFeature).toHaveLength(1)
    expect(rollup.byFeature[0]).toMatchObject({
      key: 'desk-agent',
      calls: 1,
      failedCalls: 0,
      costUsd: 0.004,
      inputTokens: 100,
      outputTokens: 20,
    })
    expect(rollup.byModel[0].key).toBe('anthropic/claude-haiku-4-5')
  })

  test('a failed chat() lands an ok=false row (a feature burning money on errors is the point)', async () => {
    const { err, lines } = await captureLog(() =>
      chat({
        feature: 'voice-refiner',
        model: 'google/gemma-4-31b',
        user: 'x',
        apiKey: 'k_test',
        retries: 0,
        fetcher: fetcherReturning(() => new Response('bad model', { status: 400 })),
      }),
    )
    expect(err).toBeDefined()
    expect(lines.find(l => l.startsWith('[openrouter] '))).toContain('ok=false')

    const rollup = querySpendRollup('24h', undefined, Date.now())
    expect(rollup.totals).toMatchObject({ calls: 1, failedCalls: 1, costUsd: 0 })
  })

  test('recordSpend is inert when the store was never initialized', () => {
    closeOpenRouterSpendStore()
    expect(() => ok('desk-agent', 'm')).not.toThrow()
    expect(querySpendRollup('24h', undefined, NOW).byFeature).toEqual([])
  })
})

// ─── Rollup maths ───────────────────────────────────────────────────

describe('querySpendRollup', () => {
  test('groups by feature, sorted by cost, with totals that equal the rows', () => {
    ok('desk-agent', 'haiku', { usage: usage({ costUsd: 0.01 }) })
    ok('desk-agent', 'opus', { usage: usage({ costUsd: 0.2, inputTokens: 900, outputTokens: 5 }) })
    ok('recap-period', 'haiku', { usage: usage({ costUsd: 0.05 }) })

    const r = querySpendRollup('24h', undefined, NOW + 1)
    expect(r.byFeature.map(g => g.key)).toEqual(['desk-agent', 'recap-period'])
    expect(r.byFeature[0].costUsd).toBeCloseTo(0.21, 10)
    expect(r.byFeature[0].calls).toBe(2)
    expect(r.byFeature[0].inputTokens).toBe(1000)
    expect(r.totals.costUsd).toBeCloseTo(0.26, 10)
    expect(r.totals.calls).toBe(3)
  })

  test('by-model breaks the spend down, and `feature` scopes it to one feature', () => {
    ok('desk-agent', 'haiku', { usage: usage({ costUsd: 0.01 }) })
    ok('desk-agent', 'opus', { usage: usage({ costUsd: 0.2 }) })
    ok('recap-period', 'opus', { usage: usage({ costUsd: 0.5 }) })

    const all = querySpendRollup('24h', undefined, NOW + 1)
    expect(all.byModel.map(g => g.key)).toEqual(['opus', 'haiku'])
    expect(all.byModel[0].costUsd).toBeCloseTo(0.7, 10)

    const scoped = querySpendRollup('24h', 'desk-agent', NOW + 1)
    expect(scoped.feature).toBe('desk-agent')
    expect(scoped.byModel.map(g => g.key)).toEqual(['opus', 'haiku'])
    expect(scoped.byModel[0].costUsd).toBeCloseTo(0.2, 10)
    // byFeature stays fleet-wide so a drill-down keeps its context
    expect(scoped.byFeature).toHaveLength(2)
    // ...and the totals still describe the whole fleet, not the scoped slice
    expect(scoped.totals.costUsd).toBeCloseTo(0.71, 10)
  })

  test('the window excludes calls older than the period', () => {
    ok('desk-agent', 'haiku', {}, NOW - 2 * HOUR)
    ok('desk-agent', 'haiku', {}, NOW - 3 * DAY)

    expect(querySpendRollup('24h', undefined, NOW).totals.calls).toBe(1)
    expect(querySpendRollup('7d', undefined, NOW).totals.calls).toBe(2)
  })

  test('litellm-priced calls are counted so an estimate is never passed off as billed', () => {
    ok('desk-agent', 'haiku', { usage: usage({ costSource: 'litellm' }) })
    ok('desk-agent', 'haiku', { usage: usage({ costSource: 'openrouter' }) })

    const r = querySpendRollup('24h', undefined, NOW + 1)
    expect(r.byFeature[0].calls).toBe(2)
    expect(r.byFeature[0].estimatedCalls).toBe(1)
  })
})

// ─── Failure accounting ─────────────────────────────────────────────

describe('failure accounting', () => {
  test('failed calls are counted and their wall-clock is attributed, without inventing cost', () => {
    ok('voice-refiner', 'gemma', { ms: 400, usage: usage({ costUsd: 0.002 }) })
    failed('voice-refiner', 'gemma', 30_000)
    failed('voice-refiner', 'gemma', 30_000)

    const g = querySpendRollup('24h', undefined, NOW + 1).byFeature[0]
    expect(g.calls).toBe(3)
    expect(g.failedCalls).toBe(2)
    // A failed call returns no usage body, so its provider-side cost is unknown
    // -- it must not silently inflate (or deflate) the billed total.
    expect(g.costUsd).toBeCloseTo(0.002, 10)
    expect(g.totalMs).toBe(60_400)
    expect(g.failedMs).toBe(60_000)
  })

  test('a feature with nothing but failures still appears in the rollup', () => {
    failed('classifier', 'gemma', 30_000)
    const r = querySpendRollup('24h', undefined, NOW + 1)
    expect(r.byFeature.map(g => g.key)).toEqual(['classifier'])
    expect(r.totals).toMatchObject({ calls: 1, failedCalls: 1, costUsd: 0, failedMs: 30_000 })
  })
})

// ─── Retention ──────────────────────────────────────────────────────

describe('retention', () => {
  test('trims past 30 days and keeps everything inside it', () => {
    ok('desk-agent', 'haiku', {}, NOW - 31 * DAY)
    ok('desk-agent', 'haiku', {}, NOW - 40 * DAY)
    ok('desk-agent', 'haiku', {}, NOW - 29 * DAY)
    ok('desk-agent', 'haiku', {}, NOW - HOUR)

    expect(trimOpenRouterSpend(NOW)).toBe(2)
    expect(querySpendRollup('30d', undefined, NOW).totals.calls).toBe(2)
    // Idempotent: a second sweep with the same clock finds nothing left to drop.
    expect(trimOpenRouterSpend(NOW)).toBe(0)
  })
})
