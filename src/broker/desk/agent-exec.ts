/**
 * Tool-call EXECUTION for the dispatcher agent loop (split out of agent.ts).
 *
 * One round of the loop may emit several tool calls; this validates each call's
 * args against its zod schema, executes it, summarizes it for the dimmed UI line,
 * and shapes the result back into a `tool` message the model sees next round. A
 * tool failure is fed BACK to the model (recoverable) rather than thrown -- only
 * cancellation propagates. `agent.ts` owns the chat loop; this owns one call.
 */

import type { ChatMessage } from '../recap/shared/openrouter-client'
import type { ToolContext, Toolset } from './tool-def'

export interface AgentToolCallEvent {
  callId: string
  name: string
  summary: string
  args: Record<string, unknown>
}
export interface AgentToolResultEvent {
  callId: string
  ok: boolean
  summary: string
  result?: unknown
  error?: string
}

/** The pair of stream emitters the loop threads through (dimmed gears in the UI). */
export interface ToolStreamers {
  onToolCall?: (e: AgentToolCallEvent) => void
  onToolResult?: (e: AgentToolResultEvent) => void
}

/** One-line human summary of a tool call for the dimmed UI line. */
function summarizeCall(name: string, args: Record<string, unknown>): string {
  const head = Object.entries(args)
    .filter(([, v]) => v != null && v !== '')
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
  return head ? `${name} ${head}` : name
}

function collectConversationId(result: unknown, into: Set<string>): void {
  if (result && typeof result === 'object' && 'conversationId' in result) {
    const id = (result as { conversationId?: unknown }).conversationId
    if (typeof id === 'string') into.add(id)
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {} // validation below surfaces the shape error
  }
}

/** A tool message + the result-event to emit -- the shared shape for every
 *  runOneCall exit (error or success), so the caller does one emit + push. */
interface CallOutcome {
  message: ChatMessage
  ok: boolean
  summary: string
  result?: unknown
  error?: string
}

function failOutcome(callId: string, error: string): CallOutcome {
  return { message: { role: 'tool', content: error, toolCallId: callId }, ok: false, summary: error, error }
}

/** Run one tool call: validate args against its zod schema, execute, summarize. */
export async function runOneCall(
  toolset: Toolset,
  call: { id: string; name: string; arguments: string },
  ctx: ToolContext,
  touched: Set<string>,
  streamers: ToolStreamers,
): Promise<ChatMessage> {
  const args = parseArgs(call.arguments)
  streamers.onToolCall?.({ callId: call.id, name: call.name, summary: summarizeCall(call.name, args), args })
  const outcome = await executeCall(toolset, call, args, ctx, touched)
  streamers.onToolResult?.({
    callId: call.id,
    ok: outcome.ok,
    summary: outcome.summary,
    result: outcome.result,
    error: outcome.error,
  })
  return outcome.message
}

async function executeCall(
  toolset: Toolset,
  call: { id: string; name: string },
  args: Record<string, unknown>,
  ctx: ToolContext,
  touched: Set<string>,
): Promise<CallOutcome> {
  const def = toolset[call.name]
  if (!def) return failOutcome(call.id, `unknown tool '${call.name}'`)
  const parsed = def.inputSchema.safeParse(args)
  if (!parsed.success) {
    return failOutcome(call.id, `bad args for ${call.name}: ${parsed.error.issues.map(i => i.message).join('; ')}`)
  }
  try {
    const result = await def.execute(parsed.data, ctx)
    collectConversationId(result, touched)
    const content = typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true })
    return { message: { role: 'tool', content, toolCallId: call.id }, ok: true, summary: `${call.name} ok`, result }
  } catch (e) {
    // A tool failure is fed BACK to the model (recoverable), not thrown -- the
    // dispatcher can apologize / try another path. Cancellation is the exception.
    if (ctx.signal?.aborted) throw e
    const error = (e as Error).message
    return {
      message: { role: 'tool', content: `error: ${error}`, toolCallId: call.id },
      ok: false,
      summary: `${call.name} failed: ${error}`,
      error,
    }
  }
}
