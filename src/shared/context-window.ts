import { isDefault1MFamily } from './models'

/**
 * Resolve the effective context window (in tokens) for a Claude Code session.
 *
 * Priority:
 *   1. Explicit context mode parsed from /model or /context stdout (authoritative).
 *   2. Variant suffix on the model id (`-1m` / `[1m]`) -- explicit 1M opt-in.
 *   3. Registry default-1M families (Opus 4.7+, Fable/Mythos 5) via `models.ts`.
 *   4. Fallback: Claude Code's 200K default.
 *
 * The default-1M decision lives in `isDefault1MFamily` (models.ts) -- the single
 * registry -- so new default-1M models work here with no edit to this file. The
 * old opus-only regex used to live here and silently mis-sized Fable as 200K.
 */
export function resolveContextWindow(model: string | undefined, contextMode?: '1m' | 'standard'): number {
  if (contextMode === '1m') return 1_000_000
  if (contextMode === 'standard') return 200_000
  if (!model) return 200_000
  if (/(-1m|\[1m\])/i.test(model)) return 1_000_000
  if (isDefault1MFamily(model)) return 1_000_000
  return 200_000
}
