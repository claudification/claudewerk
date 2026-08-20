/**
 * THE STATS TABLE's fourth producer: OpenRouter spend, on the same time axis as
 * everything else.
 *
 * `openrouter-spend.db` already answers "which feature ate the money over
 * 24h/7d/30d" and answers nothing else. It cannot put dollars next to CPU, plan
 * utilization or token flow, so "the fleet got expensive at the same moment the
 * box got hot" is not a chart anyone can draw. This files the same number a
 * second time, coarser, against the shared `(nodeId, kind, name)` vocabulary,
 * where one query reads it beside every other series.
 *
 * IT DOES NOT RETIRE OR MIGRATE `openrouter-spend.db`. That store keeps its
 * per-call rows, its by-model drill-down, its failure accounting and its 30-day
 * window, and `wall-pane-burn` keeps reading it. This is an ADDITIONAL, coarser
 * series, and both are written from the one sink so they cannot disagree.
 *
 * THE OBJECT IS THE FEATURE, THE NODE IS THE BROKER. A feature is not a thing
 * that sits on a sentinel, and the broker is not a reporting agent with a node
 * id of its own -- so the pinned `STATS_BROKER_NODE_ID` stands in, declared in
 * `shared/stats.ts` beside the kind it exists for. `name` is the `feature` tag
 * off the `ChatRequest`, which is a code-level constant rather than a label
 * someone can re-point, and there is no `label`: writing one would be the key
 * twice.
 *
 * FLOW, NOT GAUGE. Each value is what ONE round-trip cost, never a running
 * total, which is why the metric is `spend_usd` and why `_usd` is declared a
 * flow suffix. Named `usd_cost` it would have ended in no known suffix, been
 * treated as a level, and been AVERAGED into the 5-minute tail -- silently
 * dividing the money by however many calls landed in each bucket (~28 on this
 * fleet), 48 hours after the fact, with the raws deleted in the same
 * transaction.
 *
 * NON-CRITICAL, LIKE EVERY OTHER HALF OF THIS SINK. Spend accounting has never
 * been allowed to fail a `chat()` call and does not start now: this swallows its
 * own failures rather than letting one reach the caller.
 */

import { STATS_BROKER_NODE_ID } from '../shared/stats'
import type { OpenRouterSpendRecord } from './openrouter-spend-store'
import { recordStat } from './stats/store'

/**
 * File one round-trip's cost against the feature that spent it.
 *
 * SUCCESSFUL CALLS ONLY. A failure returns no usage body, so its provider-side
 * cost is unknowable here -- `openrouter-spend-store` says so about its own
 * `costUsd` column and the same fact applies. Filing 0 would put a reading on
 * the chart that says "this call was free", which is a claim rather than a
 * measurement; the failure accounting that IS knowable (calls, wall-clock burnt)
 * stays in that store. A genuine $0 success -- a free model -- is still filed,
 * because that zero was measured.
 *
 * `at` is a test seam and defaults exactly as `recordSpend` does, so the two
 * halves of the sink stamp the same instant.
 */
export function recordOpenRouterSpendStats(rec: OpenRouterSpendRecord, at: number = Date.now()): void {
  try {
    if (!rec.ok || !rec.usage) return
    recordStat({ nodeId: STATS_BROKER_NODE_ID, kind: 'feature', name: rec.feature }, 'spend_usd', rec.usage.costUsd, at)
  } catch (err) {
    console.error('[openrouter] Spend stat failed:', err)
  }
}
