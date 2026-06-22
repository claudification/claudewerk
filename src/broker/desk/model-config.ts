/**
 * Model selection knobs (plan §5 + §0 "complexity -> model tier").
 *
 * The dispatcher must NOT reach for Opus when Sonnet does the job -- the model is
 * chosen by JUDGED task complexity. A quest worker is a real CC session, so these
 * are CC model ALIASES (the sentinel's `--model`), version-independent on purpose.
 *
 * (The dispatcher LLM loop + the consolidation fold keep their own defaults in
 * agent.ts / consolidate.ts; this is the per-quest tier the dispatcher picks.)
 */

export type QuestComplexity = 'simple' | 'moderate' | 'complex'

/** The CC model a dispatched quest worker launches under, by complexity:
 *   simple   -> haiku  (a quick lookup / status check)
 *   moderate -> sonnet (a real investigation, the §0 Arr case)
 *   complex  -> opus   (deep, ambiguous, or high-stakes work) */
export function questModel(complexity: QuestComplexity): string {
  switch (complexity) {
    case 'complex':
      return 'opus'
    case 'moderate':
      return 'sonnet'
    default:
      return 'haiku'
  }
}
