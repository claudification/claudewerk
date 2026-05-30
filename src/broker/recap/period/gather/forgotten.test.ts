import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDriver } from '../../../store/sqlite/driver'
import type { StoreDriver } from '../../../store/types'
import { gatherForgotten } from './forgotten'
import type { PeriodScope } from './types'

const DAY = 86_400_000
const NOW = 1_700_000_000_000
const projectUri = 'claude://default/Users/test/proj'

/** Seed a conversation with a controlled last_activity, all-time turn count, and
 *  a tail whose final assistant message either ends on a question (open loop) or
 *  not. `agoDays` = days before NOW that the thread went cold. */
// fallow-ignore-next-line complexity
function seedConv(
  store: StoreDriver,
  o: { id: string; agoDays: number; turns: number; openLoop: boolean; status?: string; title?: string },
) {
  const last = NOW - o.agoDays * DAY
  store.conversations.create({
    id: o.id,
    scope: projectUri,
    agentType: 'claude',
    title: o.title ?? '',
    createdAt: last - 10_000,
  })
  store.conversations.update(o.id, { lastActivity: last, status: o.status ?? 'ended' })
  // All-time turns (the investment signal). Timestamps don't matter -- the
  // gather counts across all time (from:0).
  for (let i = 0; i < o.turns; i++) {
    store.costs.recordTurn({
      timestamp: last - i * 1_000,
      conversationId: o.id,
      projectUri,
      account: 'a',
      orgId: '',
      model: 'anthropic/claude-haiku-4-5',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      exactCost: true,
    })
  }
  const finalText = o.openLoop
    ? 'I scaffolded the module. Which storage backend should I wire it to?'
    : 'Done. Shipped the fix and the tests pass.'
  store.transcripts.append(o.id, 'epoch1', [
    {
      type: 'user',
      uuid: `${o.id}-u`,
      content: { message: { role: 'user', content: 'please build the thing' } },
      timestamp: last - 2_000,
    },
    {
      type: 'assistant',
      uuid: `${o.id}-a`,
      content: { message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } },
      timestamp: last - 1_000,
    },
  ])
}

describe('gatherForgotten', () => {
  let cacheDir: string
  let store: StoreDriver

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'forgotten-test-'))
    store = createSqliteDriver({ type: 'sqlite', dataDir: cacheDir })
    store.init()
  })
  afterEach(() => {
    store.close?.()
    rmSync(cacheDir, { recursive: true, force: true })
  })

  // last_7 recap: cutoff = min(periodStart=now-7d, now-floor=now-2d) = now-7d.
  const scopeLast7: PeriodScope = {
    projectUris: [projectUri],
    periodStart: NOW - 7 * DAY,
    periodEnd: NOW,
    timeZone: 'UTC',
  }

  it('surfaces stale + invested + open-loop threads, ranked by investment then abandonment', () => {
    seedConv(store, { id: 'conv_a', agoDays: 20, turns: 30, openLoop: true })
    seedConv(store, { id: 'conv_g', agoDays: 18, turns: 20, openLoop: true })
    seedConv(store, { id: 'conv_b', agoDays: 15, turns: 10, openLoop: true })
    const out = gatherForgotten(store, scopeLast7, { now: NOW })
    expect(out.threads.map(t => t.conversationId)).toEqual(['conv_a', 'conv_g', 'conv_b'])
    expect(out.threads[0].idleDays).toBe(20)
    expect(out.threads[0].turnCount).toBe(30)
    expect(out.threads[0].openQuestions.length).toBeGreaterThan(0)
  })

  it('open-loop is a HARD FILTER: invested+stale but ended-clean is dropped (still counted)', () => {
    seedConv(store, { id: 'conv_open', agoDays: 20, turns: 10, openLoop: true })
    seedConv(store, { id: 'conv_done', agoDays: 30, turns: 50, openLoop: false }) // most invested, but closed
    const out = gatherForgotten(store, scopeLast7, { now: NOW })
    expect(out.threads.map(t => t.conversationId)).toEqual(['conv_open'])
    expect(out.candidateCount).toBe(2) // both are stale+invested candidates
    expect(out.probed).toBe(2) // conv_done was probed (ranked first) then dropped
  })

  it('excludes the not-invested (< minTurns), the too-recent (in window), and the active', () => {
    seedConv(store, { id: 'conv_thin', agoDays: 20, turns: 2, openLoop: true }) // under minTurns
    seedConv(store, { id: 'conv_recent', agoDays: 3, turns: 30, openLoop: true }) // inside the 7d window
    seedConv(store, { id: 'conv_live', agoDays: 25, turns: 30, openLoop: true, status: 'active' })
    const out = gatherForgotten(store, scopeLast7, { now: NOW })
    expect(out.threads).toHaveLength(0)
    expect(out.candidateCount).toBe(0)
  })

  it('caps the surfaced threads but reports the full candidate pool', () => {
    for (let i = 0; i < 6; i++) {
      seedConv(store, { id: `conv_${i}`, agoDays: 20 + i, turns: 10 + i, openLoop: true })
    }
    const out = gatherForgotten(store, scopeLast7, { now: NOW, cap: 2 })
    expect(out.threads).toHaveLength(2)
    expect(out.candidateCount).toBe(6)
  })

  it('threshold is period-relative (alpha): a longer period only flags older threads', () => {
    seedConv(store, { id: 'conv_18d', agoDays: 18, turns: 20, openLoop: true })
    seedConv(store, { id: 'conv_40d', agoDays: 40, turns: 20, openLoop: true })
    // last_30: cutoff = now-30d -> the 18d-idle thread is NOT yet forgotten.
    const scopeLast30: PeriodScope = {
      projectUris: [projectUri],
      periodStart: NOW - 30 * DAY,
      periodEnd: NOW,
      timeZone: 'UTC',
    }
    const out = gatherForgotten(store, scopeLast30, { now: NOW })
    expect(out.threads.map(t => t.conversationId)).toEqual(['conv_40d'])
  })

  it('floor protects a sub-floor period from flagging near-fresh work', () => {
    seedConv(store, { id: 'conv_1_5d', agoDays: 1, turns: 20, openLoop: true })
    seedConv(store, { id: 'conv_3d', agoDays: 3, turns: 20, openLoop: true })
    // last_1: periodStart=now-1d, but floor 2d -> cutoff=now-2d. 1d-idle is spared.
    const scopeLast1: PeriodScope = {
      projectUris: [projectUri],
      periodStart: NOW - 1 * DAY,
      periodEnd: NOW,
      timeZone: 'UTC',
    }
    const out = gatherForgotten(store, scopeLast1, { now: NOW })
    expect(out.threads.map(t => t.conversationId)).toEqual(['conv_3d'])
  })
})
