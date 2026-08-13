/**
 * Compose every appended system prompt into a SINGLE `--append-system-prompt`.
 *
 * `claude` does not stack this flag. Passing it twice keeps only the LAST value
 * and discards the earlier one outright -- no merge, no truncated fragment, no
 * warning. Verified live against claude 2.1.221 in all three orderings, with a
 * single-flag control run to prove the probe itself was sound.
 *
 * The agent host used to pass it twice: once in `cli-args` for the spawn-injected
 * text (fork seed, nightshift preamble, SOTU brief, launch-profile suffix) and
 * once in `index` for the harness prompt. The harness prompt went last, so it ate
 * all of it. A summarized fork booted with a correctly-built `<forked>` block in
 * its launch args and none of it in its actual context, and nothing anywhere
 * reported a problem.
 *
 * So: one flag, composed here, and nowhere else pushes it.
 */

export const APPEND_SYSTEM_PROMPT_FLAG = '--append-system-prompt'

/** Blank line between sections, so stacked blocks read as separate blocks. */
const SECTION_SEPARATOR = '\n\n'

/** Commander also accepts `--append-system-prompt=TEXT` as one argv element. */
const EQUALS_FORM_PREFIX = `${APPEND_SYSTEM_PROMPT_FLAG}=`

function isNonEmpty(part: string | undefined): part is string {
  return !!part
}

/**
 * Fold `leading` plus every `--append-system-prompt` already in `args` into one
 * flag at the end of `args`. Argv order is preserved for everything else, and
 * `leading` comes first so the harness prompt reads as the base and the
 * launch-specific text lands after it.
 *
 * MUTATES `args` in place, deliberately: `brokerDeps.claudeArgs` holds the SAME
 * array by reference and is what the broker persists and the control panel
 * renders. Reassigning would leave the broker describing a launch that never
 * happened. In-place mutation makes that correct regardless of when the broker
 * serializes, so no caller has to reason about ordering.
 *
 * Call it ONCE per launch. It is a no-op on re-entry only when no new `leading`
 * parts are supplied; passing the same part twice would stack it twice.
 */
export function composeAppendSystemPrompt(args: string[], ...leading: (string | undefined)[]): void {
  const kept: string[] = []
  const found: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    // `--append-system-prompt=TEXT`. Commander accepts this form, so missing it
    // would leave a second flag in argv and reproduce the exact bug: CC keeps
    // the last one and the user's text vanishes.
    if (arg.startsWith(EQUALS_FORM_PREFIX)) {
      found.push(arg.slice(EQUALS_FORM_PREFIX.length))
      continue
    }

    if (arg !== APPEND_SYSTEM_PROMPT_FLAG) {
      kept.push(arg)
      continue
    }

    // A trailing flag with no value is malformed input (user-typed only -- the
    // broker and sentinel always send a value). Drop it rather than leave a
    // dangling flag that would swallow the composed value as its argument.
    const value = args[i + 1]
    if (value === undefined) continue
    found.push(value)
    i++ // consume the value, so a value that looks like the flag is not re-read
  }

  const merged = [...leading, ...found]
    .map(part => part?.trim())
    .filter(isNonEmpty)
    .join(SECTION_SEPARATOR)

  args.splice(0, args.length, ...kept)
  if (merged) args.push(APPEND_SYSTEM_PROMPT_FLAG, merged)
}
