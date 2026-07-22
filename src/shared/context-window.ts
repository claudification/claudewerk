import { isDefault1MFamily, MODEL_TEXT_IDENTIFIERS } from './models'

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
  // Explicit downgrade suffix -- the only way a default-1M family runs at 200K.
  if (/(-200k|\[200k\])/i.test(model)) return 200_000
  if (isDefault1MFamily(model)) return 1_000_000
  return 200_000
}

/**
 * Classify a `/model` or `/context` stdout payload as 1M vs standard.
 *
 * Evidence order:
 *   1. Explicit variant markers in the text (`(1M context)` / `[1m]` / `[200k]`).
 *   2. The model named in the text, resolved through the registry -- so a
 *      default-1M family with NO label reads as 1M.
 *   3. No recognizable model -> `undefined` (leave the session's mode alone).
 *
 * (2) is the whole point: the old rule was "no `(1M context)` label -> standard",
 * which silently downgraded every default-1M session (Opus 4.7/4.8, Sonnet 5,
 * Fable/Mythos 5) to a 200K context bar, because CC prints no label when 1M IS
 * the default. Absence of a label is NOT evidence of 200K.
 *
 * Caller must strip ANSI first -- bold is `\x1b[1m` and would read as `[1m]`.
 */
export function resolveContextModeFromText(text: string): '1m' | 'standard' | undefined {
  if (/\(1M context\)|\[1m\]/i.test(text)) return '1m'
  if (/\(200K context\)|\[200k\]/i.test(text)) return 'standard'
  const lower = text.toLowerCase()
  const hit = MODEL_TEXT_IDENTIFIERS.find(({ needle }) => lower.includes(needle))
  if (!hit) return undefined
  return resolveContextWindow(hit.familyId) === 1_000_000 ? '1m' : 'standard'
}

/**
 * Heal a persisted `contextMode` that a pre-fix broker got wrong.
 *
 * Builds before this fix wrote `contextMode: 'standard'` on EVERY `/model`
 * switch of a default-1M family, permanently pinning those conversations to a
 * fake 200K window in the control panel. A real downgrade travels in the model
 * id (`[200k]`), never in this field alone -- so a stored `standard` on a
 * default-1M model is poison, not signal. Drop it and let the registry answer.
 */
export function sanitizePersistedContextMode(
  mode: '1m' | 'standard' | undefined,
  model: string | undefined,
): '1m' | 'standard' | undefined {
  if (mode !== 'standard' || !model) return mode
  return resolveContextWindow(model) === 1_000_000 ? undefined : mode
}
