/**
 * `test_cmd:` ON A CARD -- is this a command a seat can actually RUN?
 *
 * A card's `test_cmd` is not documentation. It is handed to a dispatched
 * implementer or verifier and executed under this repo's hooks, and one of those
 * hooks HARD-DENIES the bare test runner: `guard-raw-bun-test.sh` is a PreToolUse
 * gate that refuses `bun test` and tells the caller to reach the same suite
 * through `bun run test`, because `scripts/bun-test.sh` adds a wall-clock budget
 * and a cross-worktree lock that a bare invocation has no way to carry. Two
 * leaked runs were found alive at 4h13m and 3h05m on 2026-08-19; that is what
 * the wrapper exists to stop.
 *
 * So a card carrying `test_cmd: bun test src/foo` hands a seat a command that
 * CANNOT run. The seat burns a turn discovering the denial and then either
 * improvises a different command -- at which point the card's verification is no
 * longer the card's stated verification -- or bounces. On 2026-08-22 fifty cards
 * on this board were in that state, up from thirty-four the previous day.
 *
 * WHY THE CHECK LIVES AT THE WRITE, NOT AT THE DISPATCH. The value is typed by
 * an agent that is, at that instant, still looking at the key it just typed.
 * Every later moment -- the sweep, the dispatch, the gate -- is one where nobody
 * is watching and the context is gone. Same argument as `card-model.ts`: a value
 * that only fails hours later is validated at the door.
 *
 * TWO SOURCES OF TRUTH, AND ONE OF THEM IS NOT IN THIS REPO. `.claude/hooks/` is
 * local tooling and deliberately untracked, so this module cannot import the
 * shell hook's mapping and the shell hook cannot import this. The text below is
 * a DELIBERATE mirror of `guard-raw-bun-test.sh` lines 47-50, and the pattern
 * mirrors its line 38 with the same two exemptions (lines 33 and 44). If the
 * hook's spelling of the wrapper ever changes, this is the other place to change.
 *
 * Pure string work. No `node:` imports, no fs -- it ships inside the bundle and
 * runs on hosts that have no checkout to read a hook from.
 */

import type { DoctorFinding } from './project-doctor-types'

/** The frontmatter key, spelled once. */
export const CARD_TEST_CMD_KEY = 'test_cmd'

/**
 * `bun test ...` at the start of a command or after a shell separator.
 *
 * Mirrors `guard-raw-bun-test.sh:38`. `bun run test` and `bunx` simply do not
 * match: `run` sits where `test` would have to be. The lookahead rather than a
 * consumed trailing group is what lets `bun test && bun test x` be found twice.
 */
const BARE_BUN_TEST = /(^|[\s;|&(])bun[ \t]+test(?=[\s]|$)/g

/**
 * The inline opt-out, stated in the command itself so it is visible on the card.
 * Mirrors `guard-raw-bun-test.sh:33`.
 */
const ESCAPE_HATCH = 'RCLAUDE_ALLOW_RAW_BUN_TEST=1'

/**
 * `--watch` runs until stopped, so the wrapper deliberately does not cover it and
 * neither does the hook (`guard-raw-bun-test.sh:44`). A `test_cmd` that watches
 * is a different mistake and not this one's to report.
 */
const WATCH = /(^|\s)--watch(\s|$)/

/**
 * Does this command contain a bare runner the repo's hooks would refuse?
 *
 * Accepts anything the HOOK would accept, exemptions included -- a check that is
 * stricter than the gate it speaks for teaches agents to ignore it.
 */
export function hasBareBunTest(command: string): boolean {
  if (command.includes(ESCAPE_HATCH)) return false
  if (WATCH.test(command)) return false
  // `.test()` on a /g regex is stateful; a fresh exec off a reset index is not.
  BARE_BUN_TEST.lastIndex = 0
  return BARE_BUN_TEST.test(command)
}

/**
 * The same command routed through the wrapper.
 *
 * EVERY occurrence, not the first: `bun test src/a && bun test src/b` is one
 * command with two denied invocations, and rewriting half of it produces a
 * command that still cannot run while looking like it was fixed.
 *
 * Whitespace between `bun` and `test` is normalised to a single space, which is
 * the only byte this touches beyond the inserted word.
 */
export function wrapBareBunTest(command: string): string {
  if (command.includes(ESCAPE_HATCH) || WATCH.test(command)) return command
  return command.replace(BARE_BUN_TEST, '$1bun run test')
}

export interface CardTestCmdSource {
  id: string
  /** Raw frontmatter exactly as parsed. NOT a projected card -- nothing projects
   *  this key, and the value has to be seen as the byte string a shell will get. */
  meta: Record<string, unknown>
}

/**
 * The doctor's view: a `test_cmd:` a dispatched seat cannot execute.
 *
 * ERROR, not warning. The other schema-level findings describe a value the board
 * silently ignores; this one describes a command that will be REFUSED at the
 * moment somebody depends on it, on a card whose entire purpose is to say how
 * the work gets verified. A warning would be understating it.
 *
 * NOT AUTO-REPAIRED, though `wrapBareBunTest` makes the fix unambiguous. The
 * doctor's existing repairs stamp an absent date and reshape frontmatter; this
 * one would silently rewrite a command that an unattended agent then EXECUTES.
 * A finding makes somebody look at the one line before it runs, and the
 * rewrite is one keystroke away in the remedy.
 *
 * A LIST reads as nothing at all, like every other scalar key on the board
 * (card-schema-validate.ts) -- that is `card-key-type`'s finding to file, not
 * this one's, so an unusable shape is passed over rather than double-reported.
 */
export function checkCardTestCmd(source: CardTestCmdSource): DoctorFinding[] {
  const value = source.meta[CARD_TEST_CMD_KEY]
  if (typeof value !== 'string') return []
  // Frontmatter keeps the quotes when a value was written `test_cmd: "..."`, and
  // a quoted command is still the command the seat runs.
  const command = value.trim().replace(/^["']|["']$/g, '')
  if (!hasBareBunTest(command)) return []
  return [
    {
      check: 'card-test-cmd-denied',
      severity: 'error',
      subject: source.id,
      problem: `\`${CARD_TEST_CMD_KEY}:\` uses the bare runner, which guard-raw-bun-test.sh hard-denies -- the seat dispatched here cannot run it`,
      remedy: `route it through the wrapper: \`${CARD_TEST_CMD_KEY}: ${wrapBareBunTest(command)}\``,
    },
  ]
}
