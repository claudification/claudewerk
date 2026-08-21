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

/** The floor's PreToolUse entry. One builder so the fragment `buildUnattendedSettings`
 *  ships and the one `applyDenyFloor` grafts on can never be different objects. */
function denyFloorHookEntry(): Record<string, unknown> {
  return { matcher: '', hooks: [{ type: 'command', command: denyFloorHookCommand() }] }
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
      PreToolUse: [denyFloorHookEntry()],
    },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The floor folded in, or the shape that stopped it being folded in. */
export type DenyFloorApplication = { ok: true; settings: Record<string, unknown> } | { ok: false; reason: string }

/** Is this PreToolUse entry the floor's own guard hook? */
function isDenyFloorEntry(entry: unknown, command: string): boolean {
  if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) return false
  return entry.hooks.some(hook => isPlainObject(hook) && hook.command === command)
}

/**
 * THE FLOOR, FOLDED INTO A FRAGMENT SOMEBODY ELSE WROTE.
 *
 * `buildUnattendedSettings` builds a WHOLE fragment and is therefore only usable
 * by a caller that has none of its own. This is the other half: it takes a
 * fragment that already exists -- a human's `settingsInline` on a schedule, the
 * one an order just wrote deny rules into -- and adds the floor to it, leaving
 * everything else exactly as it was found.
 *
 * ADDITIVE, NEVER REPLACING, AND NEVER THE ALLOWLIST. Both halves of the floor
 * go in: the declarative `DENY_FLOOR_RULES` unioned onto whatever `deny` is
 * there, and the imperative PreToolUse guard hook appended to whatever
 * `PreToolUse` is there -- the hook is the robust layer, since prefix rules
 * cannot catch arg-order variants of `git push ... main`, so a floor without it
 * is half a floor. `DEFAULT_ALLOW` deliberately does NOT come along: an
 * allowlist WIDENS what a `dontAsk` seat may do, and a floor that widens
 * anything is not a floor.
 *
 * IDEMPOTENT. A fragment that already carries the floor (anything built by
 * `buildUnattendedSettings`) comes back unchanged in substance -- the rules
 * dedupe and the hook entry is matched by its command, so the same settings can
 * pass through several layers without growing a second copy of the guard.
 *
 * A SHAPE THE FLOOR CANNOT BE EXPRESSED IN RETURNS A REASON. `settingsInline` is
 * an opaque bag by schema (`Record<string, unknown>`), so `permissions` might be
 * a string and `hooks.PreToolUse` might be a number. Overwriting whatever was
 * there and calling it a floor is a silent downgrade of a fragment a human
 * configured; the caller gets the reason and decides (a scheduled fire refuses,
 * loudly, into its run history).
 */
export function applyDenyFloor(settings: Record<string, unknown> | undefined): DenyFloorApplication {
  if (settings === undefined) {
    return {
      ok: true,
      settings: { permissions: { deny: [...DENY_FLOOR_RULES] }, hooks: { PreToolUse: [denyFloorHookEntry()] } },
    }
  }

  const permissions = settings.permissions
  if (permissions !== undefined && permissions !== null && !isPlainObject(permissions)) {
    return { ok: false, reason: 'settingsInline.permissions is not an object' }
  }
  const existingDeny = isPlainObject(permissions) ? permissions.deny : undefined
  if (existingDeny !== undefined && existingDeny !== null) {
    if (!Array.isArray(existingDeny) || existingDeny.some(rule => typeof rule !== 'string')) {
      return { ok: false, reason: 'settingsInline.permissions.deny is not an array of strings' }
    }
  }

  const hooks = settings.hooks
  if (hooks !== undefined && hooks !== null && !isPlainObject(hooks)) {
    return { ok: false, reason: 'settingsInline.hooks is not an object' }
  }
  const preToolUse = isPlainObject(hooks) ? hooks.PreToolUse : undefined
  if (preToolUse !== undefined && preToolUse !== null && !Array.isArray(preToolUse)) {
    return { ok: false, reason: 'settingsInline.hooks.PreToolUse is not an array' }
  }

  // The caller's own rules stay at the head of the list: the floor is appended
  // to what a human wrote, it does not reorder it.
  const deny = uniq([...((existingDeny as string[] | undefined | null) ?? []), ...DENY_FLOOR_RULES])
  const guard = denyFloorHookCommand()
  const entries = (preToolUse as unknown[] | undefined | null) ?? []
  const nextPreToolUse = entries.some(entry => isDenyFloorEntry(entry, guard))
    ? entries
    : [...entries, denyFloorHookEntry()]

  return {
    ok: true,
    settings: {
      ...settings,
      permissions: { ...(isPlainObject(permissions) ? permissions : {}), deny },
      hooks: { ...(isPlainObject(hooks) ? hooks : {}), PreToolUse: nextPreToolUse },
    },
  }
}
