/**
 * REAL-TOKEN cost experiment (plan §8) -- spends Haiku/Sonnet tokens to answer,
 * with DATA not guesses: does the living-history context stay cheap as a session
 * ages, and does consolidation pay for itself?
 *
 * Opt-in (spends real money, ~$0.02/run): gated on DESK_LIVE_TEST. Run with:
 *   DESK_LIVE_TEST=1 OPENROUTER_API_KEY=... bun test src/broker/desk/living-history.cost.live.test.ts
 *
 * It prints a per-turn usage table + a recommendations-grade summary to stdout.
 * The whole point is the printed report; the assertions just guard the thesis
 * (bounded session is cheaper than an append-only one).
 */

import { describe, expect, it } from 'bun:test'
import { type ChatMessage, chat } from '../recap/shared/openrouter-client'
import type { NormalizedUsage } from '../recap/shared/pricing'
import { consolidate } from './consolidate'
import {
  appendTurn,
  createHistory,
  estimateTokens,
  type LivingHistory,
  shouldConsolidate,
  toMessages,
} from './living-history'

const live = process.env.DESK_LIVE_TEST ? describe : describe.skip

const LOOP_MODEL = 'anthropic/claude-haiku-4.5'
const MINUTE = 60_000

const SYSTEM = [
  'You are the DISPATCHER -- a routing brain for a developer named Jonas across a',
  'fleet of dev projects. Your message history carries XML state blocks (<fleet>,',
  '<memory>, <pending>, <findings>) plus the dialogue. Read them and reply briefly',
  '(one or two sentences) as a continuation of the running conversation. Do not',
  'restate the blocks; just respond to the latest user turn in context.',
].join('\n')

// A realistic 24-intent session: project chatter, lookups, follow-ups.
const INTENTS = [
  'check with arr what sci-fi or adventure movies released this week',
  'also nudge the recap-chunking conversation, is it still stuck',
  'what did we decide about the cost gate last week',
  'spin up something to audit the broker perf numbers',
  'remind me which project the mic-ducking bug was in',
  'how much are we spending per dispatcher turn roughly',
  'pull the latest from yemaya, anything on the AGM board prep',
  'is the dispatcher deployed yet or still dormant',
  'what model tier should a moderate refactor get',
  'check arr again, did the worker report back on those movies',
  'summarize where the living-history build stands',
  'any conversations idle more than two hours i should close',
  'what was the sentinel reauth thing about',
  'kick off a quick recap for the remote-claude project',
  'did the perf audit worker finish',
  'whats the retention horizon on the memory block',
  'remind me the magic word for context',
  'check if anything needs my attention right now',
  'how big is the context window getting on this session',
  'whats the cheapest path to ask an expert about transcripts',
  'is local main ahead of origin right now',
  'what did arr find in the end',
  'wrap up, anything still pending',
  'good night, hold everything till morning',
]

interface TurnRow {
  i: number
  intent: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  liveTokens: number
  folded: boolean
}

/** Run ONE no-tool dispatcher turn over the current history; return usage. We run
 *  WITHOUT tools deliberately -- this isolates the cost of the HISTORY growing,
 *  which is exactly the variable consolidation controls. */
async function oneTurn(history: LivingHistory, cache = false): Promise<NormalizedUsage> {
  const messages: ChatMessage[] = toMessages(history)
  // Cache breakpoint: mark everything except the newest user turn as a stable
  // prefix. The provider bills the matched prefix as cacheRead on the next call.
  if (cache && messages.length >= 2) messages[messages.length - 2].cacheControl = true
  const res = await chat({
    feature: 'test',
    model: LOOP_MODEL,
    system: SYSTEM,
    messages,
    maxTokens: 120,
    temperature: 0.2,
    timeoutMs: 30_000,
    timeoutRetries: 1,
  })
  appendTurn(history, 'assistant', res.content || '(ok)', latestTs(history))
  return res.usage
}

function latestTs(history: LivingHistory): number {
  return history.turns.length ? history.turns[history.turns.length - 1].ts : 0
}

/** Drive the whole session on a COMPRESSED virtual clock so folding actually
 *  fires within the run: 6 min/turn, 30-min horizon, no debounce. With consolidate
 *  enabled, turns older than 30 (sim) minutes fold out; disabled = append-only. */
async function runSession(consolidateEnabled: boolean, cache = false): Promise<{ rows: TurnRow[]; totalCost: number }> {
  const history = createHistory()
  const horizon = 30 * MINUTE
  let now = 1_000_000
  const rows: TurnRow[] = []
  let totalCost = 0

  for (let i = 0; i < INTENTS.length; i++) {
    now += 6 * MINUTE
    appendTurn(history, 'user', INTENTS[i], now)
    const usage = await oneTurn(history, cache)
    totalCost += usage.costUsd

    let folded = false
    if (
      consolidateEnabled &&
      shouldConsolidate({ history, now, lastRunAt: -horizon, maxAgeMs: horizon, minIntervalMs: 0 })
    ) {
      const res = await consolidate({ history, now, maxAgeMs: horizon }, chat)
      if (res.ran) {
        folded = true
        totalCost += res.usage?.costUsd ?? 0
      }
    }
    rows.push({
      i,
      intent: INTENTS[i].slice(0, 28),
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      liveTokens: estimateTokens(history),
      folded,
    })
  }
  return { rows, totalCost }
}

function printTable(title: string, rows: TurnRow[], totalCost: number): void {
  console.log(`\n=== ${title} ===`)
  console.log('turn  input  out  cacheR  $turn      liveTok  fold  intent')
  for (const r of rows) {
    console.log(
      `${String(r.i).padStart(3)}  ${String(r.input).padStart(6)} ${String(r.output).padStart(4)} ` +
        `${String(r.cacheRead).padStart(6)}  ${r.costUsd.toFixed(6)}  ${String(r.liveTokens).padStart(6)}  ` +
        `${r.folded ? ' Y' : ' .'}   ${r.intent}`,
    )
  }
  const avgInput = rows.reduce((a, r) => a + r.input, 0) / rows.length
  const lastInput = rows[rows.length - 1].input
  const firstInput = rows[0].input
  console.log(
    `total $${totalCost.toFixed(6)} | avg input ${avgInput.toFixed(0)} tok | ` +
      `input drift ${firstInput} -> ${lastInput} tok`,
  )
}

live('living-history cost experiment (real tokens)', () => {
  it('BOUNDED (consolidating) stays cheaper than APPEND-ONLY as the session ages', async () => {
    const bounded = await runSession(true)
    const unbounded = await runSession(false)
    printTable('BOUNDED  (consolidation ON)', bounded.rows, bounded.totalCost)
    printTable('APPEND-ONLY  (consolidation OFF)', unbounded.rows, unbounded.totalCost)

    const boundedLastInput = bounded.rows[bounded.rows.length - 1].input
    const unboundedLastInput = unbounded.rows[unbounded.rows.length - 1].input
    const boundedPeakLive = Math.max(...bounded.rows.map(r => r.liveTokens))
    const unboundedPeakLive = Math.max(...unbounded.rows.map(r => r.liveTokens))
    console.log(
      `\n[verdict] last-turn input: bounded=${boundedLastInput} unbounded=${unboundedLastInput} tok | ` +
        `peak live history: bounded=${boundedPeakLive} unbounded=${unboundedPeakLive} tok | ` +
        `total cost: bounded=$${bounded.totalCost.toFixed(6)} unbounded=$${unbounded.totalCost.toFixed(6)}`,
    )

    // The thesis: a consolidating session's live history stays bounded while an
    // append-only one grows every turn. By the last turn the bounded context is
    // materially smaller.
    expect(boundedPeakLive).toBeLessThan(unboundedPeakLive)
    expect(boundedLastInput).toBeLessThan(unboundedLastInput)
  }, 300_000)

  it('FOLD quality + cost: Haiku vs Sonnet on the same aged batch', async () => {
    // Build a history with a chunk of aged dialogue, fold it on each tier, compare
    // the memory each produces + the cost. Answers "is Haiku accurate enough".
    const seed = (): LivingHistory => {
      const h = createHistory()
      const old = 1_000_000
      const aged = [
        'jonas: i prefer Sonnet for moderate refactors, Haiku for lookups',
        'jonas: the cost gate must stop bypassing on expensive wakes',
        'jonas: arr is the movie project, check it for new releases',
        'jonas: keep the dispatcher dormant until i greenlight deploy',
        'jonas: magic word for context is BANANA',
      ]
      for (const a of aged) appendTurn(h, 'user', a, old)
      return h
    }
    for (const model of ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5']) {
      const h = seed()
      const res = await consolidate({ history: h, now: 1_000_000 + 2 * 60 * MINUTE, model }, chat)
      console.log(`\n--- fold on ${model} ($${res.usage?.costUsd.toFixed(6)}) ---`)
      console.log(h.blocks.get('memory')?.content)
      expect(res.ran).toBe(true)
    }
  }, 120_000)

  it('PROMPT CACHING lever: stable-prefix cache breakpoint vs none (append-only)', async () => {
    // Same append-only session, run twice: cache OFF then cache ON (a breakpoint on
    // everything-but-the-newest-turn). Quantifies cacheReadTokens + the cost delta.
    // Caveat the data exposes: the dispatcher is impulse-driven and often idle past
    // the ~5min Anthropic cache TTL, so real-world hit rate is below this back-to-back
    // best case -- this is the UPPER bound on what caching buys.
    const noCache = await runSession(false, false)
    const cached = await runSession(false, true)
    const sumCacheRead = (rows: TurnRow[]) => rows.reduce((a, r) => a + r.cacheRead, 0)
    const sumCacheWrite = (rows: TurnRow[]) => rows.reduce((a, r) => a + r.cacheWrite, 0)
    printTable('APPEND-ONLY  cache OFF', noCache.rows, noCache.totalCost)
    printTable('APPEND-ONLY  cache ON', cached.rows, cached.totalCost)
    console.log(
      `\n[cache verdict] cacheRead tok: off=${sumCacheRead(noCache.rows)} on=${sumCacheRead(cached.rows)} | ` +
        `cacheWrite tok: off=${sumCacheWrite(noCache.rows)} on=${sumCacheWrite(cached.rows)} | ` +
        `total cost: off=$${noCache.totalCost.toFixed(6)} on=$${cached.totalCost.toFixed(6)}`,
    )
    expect(cached.rows.length).toBe(INTENTS.length)
  }, 300_000)
})
