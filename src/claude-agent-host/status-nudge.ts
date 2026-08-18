/**
 * THE STATUS — the Stop-hook set_status nudge.
 *
 * A backstop that reminds the agent to leave a triage signal when it forgets, but
 * deliberately MODERATED so small steps and chatter don't get nagged:
 *  - `trackStatusTurn` keeps per-turn counters (reset each user turn; count tool
 *    use + flag file mutation on PreToolUse).
 *  - `computeStatusNudge` only fires when the turn was SUBSTANTIAL (a file
 *    mutation, or a busy multi-tool turn) and no status was set — and even then
 *    the nudge is non-coercive: it asks the agent to make the subjective call
 *    (set a status OR just end the turn). Small read/lookup/chatter turns and
 *    one-off commands are never nudged.
 */

import type { HookEvent } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { debug } from './debug'

/** A Stop-hook decision returned to Claude Code (re-invokes the agent once). */
export interface HookDecision {
  decision: 'block'
  reason: string
}

/** File-mutating built-in tools — any one makes a turn "substantial" on its own.
 *  Reads/greps/globs and one-off commands don't qualify (a busy turn still does
 *  via the tool-count threshold). */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** A turn with at least this many tool calls counts as "substantial" even with no
 *  file mutation (a real multi-step turn vs a small lookup). */
const NUDGE_TOOL_THRESHOLD = 4

const STATUS_NUDGE_REASON = `You did real work this turn but never called set_status. Make the call: if this rises to a triage-worthy state -- you FINISHED what the user asked, work is STOPPED until they act, or you're STUCK on something else -- set one so the user can triage this conversation at a glance:

  set_status({ state: 'working' | 'done' | 'needs_you' | 'blocked', ... })

\`needs_you\` means WORK IS STOPPED and cannot resume until the user acts -- NOT "I have a question". Two things that are \`done\`, not \`needs_you\`:
  - SHIPPED BUT NOT DEPLOYED (needs a restart / \`build:packages\` / a cache clear). That is a NOTE, at most a caveat. Test: if they ran it tonight without telling you, would the task be complete? If yes -> \`done\` + \`notes\`.
  - FINISHED, ASKING WHAT NEXT. That is \`done\` with the question in \`pending\`. Test: if they never answered, would anything be left unfinished? If no -> \`done\`.

Keep the text fields sparse -- empty is fine, only fill what matters. But if this was just a small step, a lookup, or routine back-and-forth that does NOT change the conversation's status, you can skip it entirely -- just end your turn, no status needed. This is a one-time reminder; either a single set_status call OR ending your turn satisfies it. Do NOT explain at length.`

/**
 * Per-turn bookkeeping for the nudge. Call once per processed hook event: a new
 * user turn resets the counters; each tool use is counted and a file-mutating
 * tool flips `mutatedThisTurn`.
 */
export function trackStatusTurn(ctx: AgentHostContext, event: HookEvent): void {
  if (event.hookEvent === 'UserPromptSubmit') {
    ctx.statusSetThisTurn = false
    ctx.mutatedThisTurn = false
    ctx.toolCallsThisTurn = 0
  } else if (event.hookEvent === 'PreToolUse') {
    ctx.toolCallsThisTurn += 1
    const toolName = (event.data as { tool_name?: string } | undefined)?.tool_name
    if (toolName && MUTATING_TOOLS.has(toolName)) ctx.mutatedThisTurn = true
  }
}

/**
 * Decide whether the Stop hook should nudge the agent to call set_status. Fires at
 * most once per stop chain (guarded by CC's `stop_hook_active`) and ONLY when the
 * turn was SUBSTANTIAL: a file mutation, or a busy multi-tool turn
 * (>= NUDGE_TOOL_THRESHOLD calls). A pure-conversation turn (no tools), a small
 * read/lookup, or a one-off command never trips it.
 */
export function computeStatusNudge(ctx: AgentHostContext, event: HookEvent): HookDecision | undefined {
  if (event.hookEvent !== 'Stop') return undefined
  const stopActive = (event.data as { stop_hook_active?: boolean } | undefined)?.stop_hook_active === true
  const substantial = ctx.mutatedThisTurn || ctx.toolCallsThisTurn >= NUDGE_TOOL_THRESHOLD
  if (stopActive || ctx.statusSetThisTurn || !substantial) return undefined
  debug(
    `Stop: nudging set_status (substantial turn, no status set) mutated=${ctx.mutatedThisTurn} tools=${ctx.toolCallsThisTurn}`,
  )
  return { decision: 'block', reason: STATUS_NUDGE_REASON }
}
