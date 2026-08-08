/**
 * The three ways to fork a conversation, and what each one actually does to
 * the transcript.
 *
 * All three produce a NEW conversation resuming a NEW CC session; they differ
 * only in how much of the source survives verbatim. The numbers below come from
 * folding a real 675k-token session (see scripts/spike-fork-supercompact.ts).
 */

export type ForkStrategy = 'full' | 'compacted' | 'summarized'

export interface ForkStrategySpec {
  value: ForkStrategy
  label: string
  hint: string
  /** Digest cold tool_results over this many tokens. 0 = keep everything. */
  digestOverTokens: number
  /** Tokens of the most recent turns kept verbatim regardless. */
  tailTokenBudget: number
}

/**
 * `full` still writes a fork rather than resuming the source directly. That
 * keeps ONE code path (every strategy = fold + resume the result) and, more
 * importantly, leaves the source session untouched so the original conversation
 * stays independently resumable.
 */
export const FORK_STRATEGIES: Record<ForkStrategy, ForkStrategySpec> = {
  full: {
    value: 'full',
    label: 'Full',
    hint: 'Faithful copy. Nothing dropped -- and the first turn pays for the whole window.',
    digestOverTokens: 0,
    tailTokenBudget: Number.MAX_SAFE_INTEGER,
  },
  compacted: {
    value: 'compacted',
    label: 'Condensed',
    hint: 'Big tool outputs digested to a stub + preview, recent turns kept verbatim. Free, deterministic, ~80% smaller.',
    digestOverTokens: 400,
    tailTokenBudget: 20_000,
  },
  summarized: {
    value: 'summarized',
    label: 'Summary',
    hint: 'A written continuation summary instead of the transcript. Smallest, lossiest, costs one model call.',
    // Not used -- the summary path does not fold a transcript at all.
    digestOverTokens: 0,
    tailTokenBudget: 0,
  },
}

export const FORK_STRATEGY_ORDER: ForkStrategy[] = ['compacted', 'full', 'summarized']

/** Percent reduction, for the post-fold readout. */
export function foldReductionPct(beforeTokens: number, afterTokens: number): number {
  if (beforeTokens <= 0) return 0
  return Math.max(0, Math.round((1 - afterTokens / beforeTokens) * 100))
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}
