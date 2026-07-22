/**
 * The dispatcher AGENT LOOP (plan-dispatcher-build.md §9.4c + §11).
 *
 * The dispatcher is NOT a chat classifier -- it is a broker CONTROLLER. This is
 * the bounded tool-using loop: given an intent + a tiny context, it calls the
 * model with the control `Toolset`, EXECUTES the tools the model picks (list /
 * inject / interrupt / terminate / spawn / revive / configure / link / events),
 * feeds results back, and repeats until the model answers in plain text or the
 * round budget is spent. Every tool call + result is streamed out (onToolCall /
 * onToolResult) so the overlay can render the gears dimmed.
 *
 * Runtime-agnostic: the LLM is a `ChatFn` (OpenRouter today), the tools are the
 * local agent-core-shaped `Toolset`. Swapping to `@protokol/agent-core`'s
 * buildHarness later is mechanical -- this loop is its minimal stand-in.
 */

import { z } from 'zod'
import type { ChatMessage, ChatResponse, ChatTool } from '../recap/shared/openrouter-client'
import { type AgentToolCallEvent, type AgentToolResultEvent, runOneCall } from './agent-exec'
import type { ChatFn } from './classify'
import type { ToolContext, Toolset } from './tool-def'

export type { AgentToolCallEvent, AgentToolResultEvent } from './agent-exec'

/** Default model that drives the loop -- Haiku (tiny-context thin router by
 *  design, §9). User-switchable per request (DispatchRequest.model). */
export const DISPATCHER_MODEL = 'anthropic/claude-haiku-4.5'

const MAX_ROUNDS = 6
const MAX_TOKENS = 1024

export interface RunAgentInput {
  intent: string
  /** The dispatcher's role + authority prompt. */
  system: string
  /** Tiny context the loop reads each turn (memory + roster snapshot). */
  context?: string
  /** Seed the loop with a pre-built message array (the LIVING HISTORY: state
   *  blocks + dialogue turns, ending with the latest user turn) instead of the
   *  single `intent`. The loop layers its transient tool rounds on top. When
   *  unset, the loop starts from `[{role:'user', content: intent}]` (legacy). */
  seedMessages?: ChatMessage[]
  model: string
  toolset: Toolset
  signal?: AbortSignal
  identity?: ToolContext['identity']
  onToolCall?: (e: AgentToolCallEvent) => void
  onToolResult?: (e: AgentToolResultEvent) => void
  maxRounds?: number
}

export interface RunAgentResult {
  reply: string
  toolCallCount: number
  /** Conversation ids the loop touched (best-effort, from tool results). */
  touchedConversationIds: string[]
  model: string
}

/** Derive the OpenRouter function-tool array from the agent-core-shaped toolset. */
export function toChatTools(toolset: Toolset): ChatTool[] {
  return Object.entries(toolset).map(([name, def]) => {
    const json = z.toJSONSchema(def.inputSchema, { target: 'draft-2020-12' }) as {
      properties?: Record<string, unknown>
    }
    const properties = json.properties ?? {}
    return {
      name,
      description: def.description,
      parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    }
  })
}

export async function runAgent(input: RunAgentInput, chat: ChatFn): Promise<RunAgentResult> {
  const tools = toChatTools(input.toolset)
  const system = input.context ? `${input.system}\n\n${input.context}` : input.system
  const ctx: ToolContext = { signal: input.signal, identity: input.identity }
  // The living history (seedMessages) IS the context when provided; otherwise fall
  // back to a single intent turn. We copy so the loop's transient tool rounds never
  // mutate the caller's persistent history array.
  const messages: ChatMessage[] = input.seedMessages
    ? [...input.seedMessages]
    : [{ role: 'user', content: input.intent }]
  const touched = new Set<string>()
  const maxRounds = input.maxRounds ?? MAX_ROUNDS
  let toolCallCount = 0

  for (let round = 0; round < maxRounds; round++) {
    const last = round === maxRounds - 1
    const res: ChatResponse = await chat({
      feature: 'desk-agent',
      model: input.model,
      system,
      messages,
      tools,
      // Final round: force a text answer (no more tools) so we never end mid-loop.
      toolChoice: last ? 'none' : 'auto',
      maxTokens: MAX_TOKENS,
      temperature: 0.2,
      timeoutMs: 30_000,
      timeoutRetries: 1,
    })
    const calls = res.toolCalls ?? []
    if (calls.length === 0 || last) {
      return { reply: res.content, toolCallCount, touchedConversationIds: [...touched], model: input.model }
    }
    messages.push({ role: 'assistant', content: res.content, toolCalls: calls })
    for (const call of calls) {
      toolCallCount++
      messages.push(await runOneCall(input.toolset, call, ctx, touched, input))
    }
  }
  return { reply: '', toolCallCount, touchedConversationIds: [...touched], model: input.model }
}
