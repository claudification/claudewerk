/**
 * Resolve the effective context window (in tokens) for a Claude Code session.
 *
 * Priority:
 *   1. Explicit context mode parsed from /model or /context stdout (authoritative).
 *   2. Variant suffix on the model id (`-1m` / `[1m]`) -- explicit 1M opt-in.
 *   3. Known default-1M models (Opus 4.7+).
 *   4. Fallback: Claude Code's 200K default.
 */
export function resolveContextWindow(model: string | undefined, contextMode?: '1m' | 'standard'): number {
  if (contextMode === '1m') return 1_000_000
  if (contextMode === 'standard') return 200_000
  if (!model) return 200_000
  if (/(-1m|\[1m\])/i.test(model)) return 1_000_000
  if (isDefault1MModel(model)) return 1_000_000
  return 200_000
}

/** Models whose 1M context window is the DEFAULT, not an opt-in variant. */
function isDefault1MModel(model: string): boolean {
  // Opus 4.6+ ships with 1M context by default. The [1m] suffix is unreliable
  // -- CC strips it from assistant messages, hook data, and sometimes the init.
  // Don't rely on the suffix surviving the pipeline; just match the model family.
  return /^claude-opus-4-([6-9]|\d{2})/i.test(model) || /^opus$/i.test(model)
}
