/**
 * TICK-DRIVEN simulated-aging tests (plan §8) -- the empirical proof that the
 * living-history context stays BOUNDED and CHEAP as a session ages.
 *
 * Every engine function takes `now` as a param, so we drive a VIRTUAL clock with
 * zero real time: advance `now` by ticks, append turns, run the consolidate-if-due
 * loop. We assert the four policy behaviours fire deterministically (1h phase-out,
 * ≤10min debounce, size valve, short-circuit) and that over a long simulated
 * session the rendered context never grows unbounded.
 *
 * The LLM fold is stubbed -- this exercises the POLICY + the structural fold (drop
 * aged turns, rewrite memory), not model quality. Real-token cost lives in the
 * `.live.test.ts` experiment.
 */

import { describe, expect, test } from 'bun:test'
import type { ChatFn } from './classify'
import { consolidate } from './consolidate'
import {
  appendTurn,
  createHistory,
  estimateTokens,
  type LivingHistory,
  ONE_HOUR_MS,
  shouldConsolidate,
} from './living-history'

const MINUTE = 60_000

/** Stub fold: a realistic memory-keeper. Each fold appends ONE short bullet to
 *  memory (so memory grows monotonically unless the cap bites) -- this lets us
 *  prove the MAX_MEMORY_CHARS cap is what actually bounds the rolling block. */
function bulletFold(): ChatFn {
  return async req => {
    const prev = req.user?.match(/CURRENT MEMORY:\n([\s\S]*?)\n\nAGING/)?.[1] ?? ''
    const next = prev && prev !== '(none yet)' ? `${prev}\n- folded a batch` : '- folded a batch'
    return {
      content: next,
      raw: {},
      model: req.model,
      usage: {
        inputTokens: 200,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0002,
        costSource: 'openrouter',
      },
    }
  }
}

interface SimState {
  history: LivingHistory
  now: number
  lastRunAt: number
  llmCalls: number
}

/** One driver step: advance the clock, optionally append a user+assistant turn,
 *  then run consolidation IF the policy says it's due. Counts LLM calls so the
 *  short-circuit (no call) and the debounce (skip) are observable. */
async function step(
  s: SimState,
  chat: ChatFn,
  opts: { advanceMs: number; turn?: string; sizeTokenLimit?: number; minSizeForTimeTrigger?: number },
): Promise<void> {
  s.now += opts.advanceMs
  if (opts.turn) {
    appendTurn(s.history, 'user', opts.turn, s.now)
    appendTurn(s.history, 'assistant', `re: ${opts.turn}`, s.now)
  }
  const due = shouldConsolidate({
    history: s.history,
    now: s.now,
    lastRunAt: s.lastRunAt,
    sizeTokenLimit: opts.sizeTokenLimit,
    // Default the floor to 0 in the sim so the focused phase-out/debounce mechanic
    // tests fire on tiny histories; the BOUNDED test sets a realistic floor.
    minSizeForTimeTrigger: opts.minSizeForTimeTrigger ?? 0,
  })
  if (!due) return
  const res = await consolidate({ history: s.history, now: s.now }, chat)
  s.llmCalls++
  if (res.ran) s.lastRunAt = s.now
}

function freshSim(): SimState {
  return { history: createHistory(), now: 1_000_000, lastRunAt: -ONE_HOUR_MS, llmCalls: 0 }
}

describe('tick-driven aging simulation', () => {
  test('SHORT-CIRCUIT: an idle session makes ZERO llm calls', async () => {
    const s = freshSim()
    const chat = bulletFold()
    // 12 hours of idle ticks, no turns -> nothing ever ages in, never folds.
    for (let i = 0; i < 72; i++) await step(s, chat, { advanceMs: 10 * MINUTE })
    expect(s.llmCalls).toBe(0)
    expect(estimateTokens(s.history)).toBe(0)
  })

  test('1h PHASE-OUT: a turn folds out roughly an hour after it lands', async () => {
    const s = freshSim()
    const chat = bulletFold()
    await step(s, chat, { advanceMs: MINUTE, turn: 'check arr' })
    // 50 min later: still inside the 1h window, nothing aged, no fold.
    await step(s, chat, { advanceMs: 50 * MINUTE })
    expect(s.llmCalls).toBe(0)
    expect(s.history.turns.length).toBe(2)
    // cross the 1h horizon -> the turn ages out and folds, raw turns drop.
    await step(s, chat, { advanceMs: 15 * MINUTE })
    expect(s.llmCalls).toBe(1)
    expect(s.history.turns.length).toBe(0)
    expect(s.history.blocks.get('memory')).toBeDefined()
  })

  test('≤10min DEBOUNCE: two aged batches inside 10 min fold only once', async () => {
    const s = freshSim()
    const chat = bulletFold()
    // Two turns, 2 min apart, both well past the horizon by the time we tick.
    appendTurn(s.history, 'user', 'a', s.now - 2 * ONE_HOUR_MS)
    appendTurn(s.history, 'user', 'b', s.now - 2 * ONE_HOUR_MS + 2 * MINUTE)
    s.lastRunAt = s.now - 2 * ONE_HOUR_MS // a fold ran 2h ago
    // First tick: interval long elapsed -> folds both aged turns at once.
    await step(s, chat, { advanceMs: MINUTE })
    expect(s.llmCalls).toBe(1)
    // A new turn ages out 5 min later; interval NOT elapsed -> debounced, no fold.
    appendTurn(s.history, 'user', 'c', s.now - 2 * ONE_HOUR_MS)
    await step(s, chat, { advanceMs: 5 * MINUTE })
    expect(s.llmCalls).toBe(1) // still 1 -- debounce held
    // After the 10-min interval clears -> it folds.
    await step(s, chat, { advanceMs: 6 * MINUTE })
    expect(s.llmCalls).toBe(2)
  })

  test('SIZE VALVE: a big block forces a fold before the interval elapses', async () => {
    const s = freshSim()
    const chat = bulletFold()
    s.lastRunAt = s.now // a fold JUST ran -> interval definitely not elapsed
    // Land an aged turn that is also enormous; tiny size limit -> valve trips.
    appendTurn(s.history, 'user', 'x'.repeat(40_000), s.now - 2 * ONE_HOUR_MS)
    await step(s, chat, { advanceMs: MINUTE, sizeTokenLimit: 500 })
    expect(s.llmCalls).toBe(1) // valve bypassed the 10-min interval
  })

  test('BOUNDED: 24h of steady traffic keeps the rendered context capped', async () => {
    const s = freshSim()
    const chat = bulletFold()
    let peakTokens = 0
    // A turn every 5 minutes for 24 simulated hours = 288 user+assistant pairs.
    // Realistic 1500-tok floor (§8a): fold only when the history is worth a call.
    for (let i = 0; i < 288; i++) {
      await step(s, chat, {
        advanceMs: 5 * MINUTE,
        turn: `request ${i} about some project work`,
        minSizeForTimeTrigger: 1500,
      })
      peakTokens = Math.max(peakTokens, estimateTokens(s.history))
    }
    // The size floor lets the live window grow to ~1500 tok, then a fold clears the
    // aged turns. Bounded around the floor -- nowhere near the ~6000+ tok an
    // append-only 288-pair transcript would reach.
    expect(peakTokens).toBeLessThan(3000)
    // Memory block exists and is itself capped (the rolling recollection).
    const memChars = s.history.blocks.get('memory')?.content.length ?? 0
    expect(memChars).toBeLessThanOrEqual(2001) // MAX_MEMORY_CHARS + ellipsis
  })
})
