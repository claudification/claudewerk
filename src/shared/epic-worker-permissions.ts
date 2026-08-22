/**
 * THE MUTE -- "no worker BLOCKS on a human", enforced rather than asked for.
 *
 * `dontAsk` was already the unattended permission mode, and it is often mistaken
 * for this. It is not: `dontAsk` suppresses CC's own PERMISSION prompts. It does
 * nothing at all about an agent deciding to call `dialog` and ask Jonas a
 * question, which is exactly what a stuck werk-worker does. Left prompt-only, the
 * rule holds right up until the moment it matters.
 *
 * WHAT IS ACTUALLY BEING PREVENTED is an agent PARKING ITSELF on an answer that
 * will not come -- not an agent emitting information. That distinction decides
 * the list below, and it is why `notify` and `send_message` stay ALLOWED:
 *   - `dialog` / `AskUserQuestion` BLOCK. The worker stops until a human replies,
 *     and no human is watching an unattended run, so the turn is simply lost.
 *   - `notify` is one-way and fire-and-forget. A worker that finds something
 *     alarming should be able to say so; it does not stop working to say it.
 *   - `send_message` is routing between conversations, not an interruption.
 *     A worker telling the werk-master something directly is the system working.
 *
 * The mute is a PreToolUse hook keyed on tool NAME, layered on the existing
 * deny-floor (which is keyed on bash command text). Same shape, same jq+grep
 * style, same "block" verdict -- and the blocked message names the escape hatch,
 * because an agent told only "no" invents an answer instead, which is worse than
 * the interruption we were trying to prevent.
 */

import { type EpicRole, mayAskHuman } from './epic-run-types'
import { buildUnattendedSettings, type UnattendedPermissionConfig } from './unattended-permissions'

/**
 * Every BLOCKING ask, as an ERE alternation over tool names. Anchored, because a
 * tool merely containing one of these words is not necessarily a way out of the
 * box, and over-blocking breaks a worker for reasons nobody can diagnose.
 *
 * Deliberately NOT here: `notify`, `send_message`. See the header.
 */
const MUTED_TOOL_REGEX = '^(AskUserQuestion|mcp__rclaude__(dialog|update_dialog|reopen_dialog|close_dialog))$'

/** The refusal a werk-worker sees, and the only place it learns what to do. */
export const MUTE_REASON =
  'BLOCKED: you may not park yourself waiting on a human -- nobody is watching this run, so the answer would ' +
  'never come. This is by design, not a bug. ' +
  'If you are blocked on a DECISION: file a card tagged `needs-werk-master` carrying the question (with your ' +
  "recommendation), add its id to your own card's `depends_on`, append a `## Blocked` section to your card, " +
  'set your card back to `open`, push what you have, and STOP. The werk-master answers it. ' +
  'If you only need to TELL someone something, notify and send_message still work -- they do not block. ' +
  'Do NOT retry this call and do NOT guess an answer.'

/**
 * The hook command. Reads the CC hook event from stdin, blocks when the tool
 * name matches. Mirrors `denyFloorHookCommand()` deliberately -- one style for
 * both guards means one thing to debug when a worker mysteriously stops.
 */
export function muteHookCommand(): string {
  const blockJson = JSON.stringify({ decision: 'block', reason: MUTE_REASON })
  return (
    `read -r data; ` +
    `tool=$(echo "$data" | jq -r '.tool_name // empty' 2>/dev/null); ` +
    `if [ -n "$tool" ] && echo "$tool" | grep -qE '${MUTED_TOOL_REGEX}'; then ` +
    `echo ${JSON.stringify(blockJson)}; fi`
  )
}

/** Pure predicate, same logic as the shell hook. For tests and any in-process guard. */
export function isMutedTool(toolName: string): boolean {
  return new RegExp(MUTED_TOOL_REGEX).test(toolName)
}

/**
 * The settings an epic-run worker spawns with: the unattended allowlist +
 * deny-floor, plus the mute for every role that is not the werk-master.
 *
 * The werk-master gets the deny-floor too. It may talk to Jonas; it may still not
 * force-push or `sudo`.
 */
export function buildEpicWorkerSettings(
  role: EpicRole,
  config: UnattendedPermissionConfig = {},
): Record<string, unknown> {
  const base = buildUnattendedSettings(config)
  if (mayAskHuman(role)) return base

  const hooks = base.hooks as { PreToolUse: Array<Record<string, unknown>> }
  return {
    ...base,
    hooks: {
      ...hooks,
      PreToolUse: [...hooks.PreToolUse, { matcher: '', hooks: [{ type: 'command', command: muteHookCommand() }] }],
    },
  }
}
