/**
 * Thinking-summary display -- the single source of truth for CC's
 * `thinking.display` opt-in.
 *
 * CC 2.1.221 sends `thinking: { type: 'adaptive', display: 'summarized' | 'omitted' }`.
 * The API default is `omitted` on every 4.7+ model (Opus 5, Opus 4.8/4.7, Fable 5,
 * Mythos 5), which is why a transcript's `thinking` blocks arrive with an empty
 * `thinking` string and a signature only. `summarized` brings the readable
 * reasoning back.
 *
 * Two CC surfaces exist and they do NOT overlap:
 *   - `--thinking-display <summarized|omitted>` -- a real CLI flag, but HIDDEN
 *     from `claude --help`. Wins over everything and works in every mode.
 *   - `showThinkingSummaries: true` in CC's settings.json -- consulted ONLY on
 *     the interactive branch. Silently ignored under `--print`/stream-json.
 * Every claudewerk transport (headless, pty, claude-daemon) is non-interactive
 * from CC's point of view, so we always use the FLAG.
 *
 * Consumers:
 * - Resolver:    src/shared/spawn-defaults.ts (explicit > profile > project > global)
 * - Sentinel:    src/sentinel/index.ts (env), src/sentinel/daemon-dispatch.ts (worker argv)
 * - Agent host:  src/claude-agent-host/cli-args.ts (env -> claude argv)
 * - Control panel: web/src/components/spawn-dialog.tsx + launch-profiles/
 */

/** CC's `thinking.display` values. */
export type ThinkingDisplay = 'summarized' | 'omitted'

/** The hidden-but-real CC flag that carries the choice. */
export const THINKING_DISPLAY_FLAG = '--thinking-display'

/**
 * Env var the sentinel sets on the agent-host process; `cli-args.ts` turns it
 * into `--thinking-display <value>`. `CLAUDWERK_` prefix per the NAMING covenant.
 */
export const THINKING_DISPLAY_ENV = 'CLAUDWERK_THINKING_DISPLAY'

/**
 * Thinking summaries are ON unless something explicitly turns them off. Readable
 * reasoning is the whole point of watching an agent work; the tokens are billed
 * either way (CC: "charged for all thinking tokens generated, even when collapsed
 * or redacted"), so opting out buys nothing but a blind transcript.
 */
export const DEFAULT_THINKING_SUMMARIES = true

/** Map the user-facing boolean onto CC's wire value. `undefined` -> the default. */
export function thinkingDisplayValue(enabled: boolean | undefined): ThinkingDisplay {
  return (enabled ?? DEFAULT_THINKING_SUMMARIES) ? 'summarized' : 'omitted'
}

/** Narrow an untrusted env/CLI string to a ThinkingDisplay, else undefined. */
export function parseThinkingDisplay(raw: string | undefined): ThinkingDisplay | undefined {
  return raw === 'summarized' || raw === 'omitted' ? raw : undefined
}
