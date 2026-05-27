/**
 * Worktree -> currentPath bridge.
 *
 * When CC runs its built-in `EnterWorktree` / `ExitWorktree` tool the agent's
 * working directory changes, but CC does NOT reliably fire the real `CwdChanged`
 * hook for it (observed null on every conversation in prod). So the agent host
 * derives the move from the TOOL RESULT -- CC attaches the resolved worktree
 * path to the result's `toolUseResult` sidecar -- and synthesizes a `CwdChanged`
 * hook event.
 *
 * This reuses the existing CwdChanged pipeline end-to-end: the broker's
 * `handleCwdChanged` sets `conv.currentPath` and `addEvent` broadcasts a
 * conversation update to the control panel. No new wire message, no broker
 * changes. `CwdChanged` is a PASSIVE hook, so synthesizing it never flips the
 * conversation status to active.
 *
 * `conversation.project` (the project identity URI) is deliberately left
 * untouched -- worktrees belong to their parent project. The live "working in
 * worktree X" signal is `currentPath`, which is exactly what this populates.
 */

import type { CwdChangedData, HookEvent, TranscriptContentBlock, TranscriptEntry } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'

const WORKTREE_TOOLS = new Set(['EnterWorktree', 'ExitWorktree'])
const PATH_KEYS = ['worktreePath', 'cwd', 'path'] as const

/** Pull the resolved worktree path out of a translated tool_result block's
 *  origin payload. CC attaches `{ worktreePath, message }` to the
 *  `toolUseResult` sidecar; the human message is parsed as a fallback. */
// fallow-ignore-next-line complexity
function worktreePathFromResult(block: TranscriptContentBlock): string | undefined {
  const tur = (block.raw as { toolUseResult?: unknown } | undefined)?.toolUseResult as
    | Record<string, unknown>
    | undefined
  for (const key of PATH_KEYS) {
    const v = tur?.[key]
    if (typeof v === 'string' && v) return v
  }
  const msg = typeof tur?.message === 'string' ? tur.message : ''
  return msg.match(/worktree at (\/\S+?)\.?(?:\s|$)/)?.[1]
}

/** The cwd a single block moves CC to, or undefined if it's not a (successful)
 *  worktree enter/exit. Enter -> resolved worktree path; Exit -> the boot cwd. */
// fallow-ignore-next-line complexity
function cwdFromBlock(ctx: AgentHostContext, block: TranscriptContentBlock): string | undefined {
  if (block.type !== 'tool_result' || block.is_error) return undefined
  const toolName = (block.raw as { name?: string } | undefined)?.name
  if (!toolName || !WORKTREE_TOOLS.has(toolName)) return undefined
  return toolName === 'ExitWorktree' ? ctx.cwd : worktreePathFromResult(block)
}

/** Last worktree-move cwd in a batch (later wins), or undefined if none. */
// fallow-ignore-next-line complexity
function scanWorktreeCwd(ctx: AgentHostContext, entries: TranscriptEntry[]): string | undefined {
  let nextCwd: string | undefined
  for (const entry of entries) {
    if (entry.type !== 'user') continue
    const content = (entry as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as TranscriptContentBlock[]) {
      const cwd = cwdFromBlock(ctx, block)
      if (cwd) nextCwd = cwd
    }
  }
  return nextCwd
}

/**
 * Scan a LIVE (non-replay, parent) batch of dialect-translated entries for the
 * most recent worktree enter/exit. If the resulting cwd differs from the last
 * one emitted, synthesize + send a `CwdChanged` event. Returns the emitted cwd
 * (or undefined when nothing changed) -- handy for tests.
 *
 * MUST be called AFTER `translateClaudeBlocks` so `block.raw.name` (the source
 * tool) and `block.raw.toolUseResult` are populated.
 */
// fallow-ignore-next-line complexity
export function detectWorktreeCwd(ctx: AgentHostContext, entries: TranscriptEntry[]): string | undefined {
  const nextCwd = scanWorktreeCwd(ctx, entries)
  if (!nextCwd || nextCwd === ctx.lastWorktreeCwd) return undefined

  const prev = ctx.lastWorktreeCwd ?? ctx.cwd
  ctx.lastWorktreeCwd = nextCwd

  const data: CwdChangedData = { session_id: ctx.claudeSessionId ?? '', cwd: nextCwd }
  const event: HookEvent = {
    type: 'hook',
    conversationId: ctx.conversationId,
    hookEvent: 'CwdChanged',
    timestamp: Date.now(),
    data,
  }
  ctx.wsClient?.sendHookEvent(event)
  ctx.debug(`[worktree] cwd ${prev} -> ${nextCwd} (conv=${ctx.conversationId.slice(0, 8)}) synthesized CwdChanged`)
  return nextCwd
}
