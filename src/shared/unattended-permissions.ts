/**
 * UNATTENDED PERMISSIONS -- the settings an unattended worker (nightshift / quest
 * leg) spawns with so `dontAsk` mode is USABLE out of the box (plan-quest-engine
 * §6a, plan-nightshift §10).
 *
 * `dontAsk` denies anything not on `permissions.allow`; with no allowlist a worker
 * can do NOTHING -- the H1 field finding (2026-07-05): every tool denied, so today
 * only `auto` is viable. This module builds the settings object the broker hands
 * to the sentinel as OPAQUE DATA (the sentinel materializes the file, honoring the
 * broker-FS boundary -- broker never writes host files). It carries:
 *   - a sane DEFAULT allowlist (read/edit/write, tests/lint/build, git add/commit/
 *     branch, push to the worker's OWN branch), merged with the per-project `allow`;
 *   - the always-on DENY-FLOOR: catastrophic / irreversible actions that bite in
 *     EVERY mode incl. bypassPermissions -- CC `permissions.deny` rules are enforced
 *     regardless of `--permission-mode`. Force-push, push to main/master, external
 *     sends, sudo, process kills, deletes outside the worktree.
 *
 * The DENY-FLOOR ships as BOTH declarative deny rules (best-effort prefix match)
 * AND an imperative PreToolUse guard hook (`denyFloorHookCommand`) that regex-scans
 * the bash command -- the robust layer, since prefix rules cannot catch arg-order
 * variants of `git push ... main`. Worktree isolation is the last backstop (§10):
 * worst case a worker dirties its own branch, never main.
 */

/** Sane default allowlist so `dontAsk` is usable out of the box (§6a). Per-project
 *  `config.allow` is merged on top. Deliberately conservative: local cwd work +
 *  the test/commit loop + pushing the worker's OWN branch (never main -- see floor). */
export const DEFAULT_ALLOW: readonly string[] = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'LS',
  'NotebookEdit',
  'TodoWrite',
  'Task',
  'Bash(bun test:*)',
  'Bash(bun run test:*)',
  'Bash(bun run lint:*)',
  'Bash(bun run lint:boundary:*)',
  'Bash(bun run typecheck:*)',
  'Bash(bun run build:*)',
  'Bash(bun install:*)',
  'Bash(bun x:*)',
  'Bash(bunx:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
  'Bash(git checkout -b:*)',
  'Bash(git switch -c:*)',
  'Bash(git push origin HEAD:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(rg:*)',
  'Bash(grep:*)',
  'Bash(find:*)',
  'Bash(echo:*)',
  'Bash(mkdir:*)',
]

/** Declarative CC deny rules (prefix match). The imperative hook below is the
 *  robust layer; these are belt-and-suspenders for the clearly-expressible forms. */
export const DENY_FLOOR_RULES: readonly string[] = [
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
  'Bash(git push origin main:*)',
  'Bash(git push origin master:*)',
  'Bash(sudo:*)',
  'Bash(kill:*)',
  'Bash(killall:*)',
  'Bash(pkill:*)',
  'Bash(imsg:*)',
  'Bash(shutdown:*)',
  'Bash(reboot:*)',
]

/**
 * Extended-regex fragments for the imperative deny-floor guard. Matched anywhere
 * in the bash command (no anchors) by BOTH the TS predicate (`violatesDenyFloor`)
 * and the shell hook (`denyFloorHookCommand`) -- one source of truth so they can
 * never drift. Keep to a portable ERE subset (no backrefs / lookaround) since the
 * same string feeds `grep -E`. `reason` is for the TS predicate's message only.
 */
const DENY_FLOOR_PATTERNS: ReadonlyArray<{ ere: string; reason: string }> = [
  { ere: 'git +push[^&|;]*(--force|--force-with-lease|-f( |$))', reason: 'force-push' },
  { ere: 'git +push([^&|;]* )?(origin +)?(main|master)( |$)', reason: 'push to mainline' },
  { ere: '(^| )sudo ', reason: 'sudo (privilege escalation)' },
  { ere: 'rm +(-[a-zA-Z]+ +)*(/|~)( |/|$)', reason: 'delete of / or ~ (outside worktree)' },
  { ere: '(^| )(kill|killall|pkill) ', reason: 'process kill' },
  { ere: '(^| )(imsg|osascript) ', reason: 'external send (iMessage / AppleScript)' },
  { ere: 'curl [^&|;]*(-X +(POST|PUT|PATCH|DELETE)|--data|-d )', reason: 'curl write/exfil' },
  { ere: 'wget [^&|;]*--post', reason: 'wget POST (exfil)' },
]

/** The joined ERE alternation (all fragments OR-ed). Shared by predicate + hook. */
export const DENY_FLOOR_REGEX: string = DENY_FLOOR_PATTERNS.map(p => `(${p.ere})`).join('|')

/**
 * Pure predicate: does this tool call hit the deny-floor? Returns the human reason
 * (for logging / a blocked-report) or null when clear. Only Bash commands are
 * scanned -- the catastrophic set is all shell. Exported for unit tests AND so a
 * future in-process guard can reuse the exact same logic as the shell hook.
 */
export function violatesDenyFloor(toolName: string, command: string | undefined): string | null {
  if (toolName !== 'Bash' || !command) return null
  for (const { ere, reason } of DENY_FLOOR_PATTERNS) {
    if (new RegExp(ere).test(command)) return reason
  }
  return null
}

/** The blocked-report reason surfaced to a tripped worker. */
const DENY_FLOOR_BLOCK_REASON =
  'BLOCKED by the unattended deny-floor: this command is in the catastrophic set ' +
  '(force-push / push to main / external send / sudo / kill / delete outside the worktree). ' +
  'Do NOT retry or work around it. STOP and write a blocked-report.'

/**
 * The PreToolUse guard-hook shell command. Reads the CC hook event JSON from stdin,
 * pulls the Bash command, and emits a `{"decision":"block"}` verdict when it hits
 * DENY_FLOOR_REGEX. Mirrors the existing SendMessage-block hook style (jq + grep).
 * The returned string is a JS value; JSON.stringify (sentinel materialization)
 * handles all escaping.
 */
export function denyFloorHookCommand(): string {
  const blockJson = JSON.stringify({ decision: 'block', reason: DENY_FLOOR_BLOCK_REASON })
  return (
    `read -r data; ` +
    `cmd=$(echo "$data" | jq -r 'select((.tool_name // "")=="Bash") | .tool_input.command // empty' 2>/dev/null); ` +
    `if [ -n "$cmd" ] && echo "$cmd" | grep -qE '${DENY_FLOOR_REGEX}'; then ` +
    `echo ${JSON.stringify(blockJson)}; fi`
  )
}

/** Per-project overrides layered on the defaults. Shape overlaps NightshiftConfig. */
export interface UnattendedPermissionConfig {
  allow?: string[]
  deny?: string[]
}

/** Dedupe preserving first-seen order. */
function uniq(items: string[]): string[] {
  return [...new Set(items)]
}

/**
 * Build the settings object an unattended worker spawns with: the merged
 * allow/deny permission rules + the deny-floor PreToolUse guard hook. Returned as
 * a plain object (a `settings.json` fragment) for the sentinel to materialize and
 * the agent host to MERGE into its generated hooks settings. Pure data -- no host
 * filesystem, no cwd logic (broker boundary safe).
 */
export function buildUnattendedSettings(config: UnattendedPermissionConfig = {}): Record<string, unknown> {
  return {
    permissions: {
      allow: uniq([...DEFAULT_ALLOW, ...(config.allow ?? [])]),
      deny: uniq([...DENY_FLOOR_RULES, ...(config.deny ?? [])]),
    },
    hooks: {
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: denyFloorHookCommand() }] }],
    },
  }
}
