/**
 * COST 2 -- the recap ENGINE cost ledger. Accumulates one entry per LLM call
 * (oneshot / map per chunk / reduce / retry) across a single recap run, so we
 * can see exactly which models + calls a $X recap bought. Recorded for EVERY
 * call including failures (the old aggregate dropped retry cost and recorded
 * $0 on failed runs that actually burned tokens).
 *
 * Pure + synchronous: the orchestrator owns timing and feeds normalized usage
 * in; this module never calls the network. Persisted via store as ledger_json
 * and surfaced on RecapMeta.costLedger (api_and_report).
 */

import type { RecapCostLedger, RecapLedgerEntry, RecapLedgerStage, RecapLedgerSummary } from '../../../shared/protocol'
import type { NormalizedUsage } from '../shared/pricing'

/** Bump when RecapLedgerEntry's shape changes incompatibly. */
export const RECAP_LEDGER_VERSION = 1

export interface AddCallArgs {
  stage: RecapLedgerStage
  model: string
  usage: NormalizedUsage
  ms: number
  chunkIndex?: number
  ok?: boolean
  error?: string
}

export class RecapLedger {
  private readonly entries: RecapLedgerEntry[] = []

  /** Record one LLM call. `ok` defaults to true; pass false + error on failure.
   *  Optional fields use conditional spreads (exactOptionalPropertyTypes-safe,
   *  same idiom as parse-recap's toItem). */
  // fallow-ignore-next-line complexity
  addCall(args: AddCallArgs): void {
    const { usage } = args
    this.entries.push({
      stage: args.stage,
      model: args.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd,
      costSource: usage.costSource,
      ms: args.ms,
      ok: args.ok ?? true,
      ...(args.chunkIndex !== undefined ? { chunkIndex: args.chunkIndex } : {}),
      ...(usage.inputCostUsd !== undefined ? { inputCostUsd: usage.inputCostUsd } : {}),
      ...(usage.outputCostUsd !== undefined ? { outputCostUsd: usage.outputCostUsd } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    })
  }

  /** Total billed cost across every recorded call (incl. failures). Used by
   *  the persist-on-failure path to record real spend on a failed run. */
  totalCostUsd(): number {
    return this.entries.reduce((sum, e) => sum + e.costUsd, 0)
  }

  /** Snapshot the ledger as the wire/persist shape. Safe to call repeatedly
   *  (e.g. on each incremental flush AND at finalize). */
  build(): RecapCostLedger {
    return { version: RECAP_LEDGER_VERSION, entries: this.entries.slice(), summary: this.summarize() }
  }

  private summarize(): RecapLedgerSummary {
    const byStage: RecapLedgerSummary['byStage'] = {}
    const models: string[] = []
    let totalCostUsd = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheWriteTokens = 0
    for (const e of this.entries) {
      totalCostUsd += e.costUsd
      totalInputTokens += e.inputTokens
      totalOutputTokens += e.outputTokens
      totalCacheReadTokens += e.cacheReadTokens
      totalCacheWriteTokens += e.cacheWriteTokens
      if (!models.includes(e.model)) models.push(e.model)
      const slot = byStage[e.stage] ?? { calls: 0, costUsd: 0 }
      slot.calls += 1
      slot.costUsd += e.costUsd
      byStage[e.stage] = slot
    }
    return {
      totalCostUsd,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      callCount: this.entries.length,
      models,
      byStage,
    }
  }
}
