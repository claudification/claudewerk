/**
 * CRASH HINT CATALOG (plan-quest-engine.md §6d) -- the known-cause knowledge the
 * crash investigator is armed with. Each entry maps a recognizable crash
 * signature to a plain-language `hint` (what went wrong) + a `remedy` (what the
 * retry must do differently). The catalog GROWS per incident (lessons-learned):
 * every new class of crash we diagnose lands here so the next occurrence is
 * triaged deterministically instead of blind-retried.
 *
 * STRATEGY MAP covenant: a `Record<string, hint>` keyed by a stable slug, not an
 * if/else chain. `matchCrashHint` walks it in insertion order and returns the
 * first entry whose `pattern` matches the crash text.
 *
 * The catalog is pure + dependency-free so both the broker (deterministic
 * hint-match verdict) and the spawned investigator leg (its prompt embeds the
 * whole catalog via `formatHintCatalog`) share ONE source of truth.
 */

export interface CrashHint {
  /** Case-insensitive substring or RegExp tested against the crash text
   *  (exit note + last transcript lines). */
  pattern: RegExp | string
  /** What went wrong, in one line -- shown in the investigator prompt + logs. */
  hint: string
  /** What a retry must do DIFFERENTLY. A blind re-run would hit the same wall;
   *  this is the correcting action (e.g. respawn at the project root). */
  remedy: string
}

/**
 * The seeded catalog. Entry #1 is the worktree-cleanup CWD crash (§6d): CC dies
 * when its working directory is deleted under it (a sibling worktree teardown
 * races the still-running worker). The remedy is NEVER a blind retry -- recreate
 * the worktree or respawn with cwd = project root.
 */
export const CRASH_HINTS: Record<string, CrashHint> = {
  'cwd-removed': {
    pattern: /(no such file or directory|getcwd|uv_cwd|cannot access|working directory|chdir|ENOENT.*cwd)/i,
    hint: 'CC crashed because its working directory was deleted under it (worktree cleanup raced the still-running worker).',
    remedy:
      'Do NOT blind-retry in the same worktree -- recreate the worktree or respawn with cwd = the project root checkout.',
  },
}

/** The first catalog entry whose pattern matches `text`, or null. Deterministic:
 *  insertion-order walk, no scoring. `text` is the assembled crash context
 *  (exit note + tail of the transcript). */
export function matchCrashHint(text: string): { key: string; hint: CrashHint } | null {
  if (!text) return null
  for (const [key, hint] of Object.entries(CRASH_HINTS)) {
    const matched =
      typeof hint.pattern === 'string'
        ? text.toLowerCase().includes(hint.pattern.toLowerCase())
        : hint.pattern.test(text)
    if (matched) return { key, hint }
  }
  return null
}

/** Render the whole catalog as a numbered block for the investigator's prompt.
 *  The investigator matches the crash context against these known causes before
 *  proposing a verdict. */
export function formatHintCatalog(): string {
  const entries = Object.entries(CRASH_HINTS)
  if (entries.length === 0) return '(catalog empty)'
  return entries
    .map(([key, h], i) => {
      const sig = typeof h.pattern === 'string' ? h.pattern : h.pattern.source
      return `${i + 1}. [${key}] signature: /${sig}/\n   cause: ${h.hint}\n   remedy: ${h.remedy}`
    })
    .join('\n')
}
