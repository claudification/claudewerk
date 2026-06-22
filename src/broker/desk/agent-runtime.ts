/**
 * Live entrypoint for the dispatcher AGENT loop (plan-dispatcher-build.md §11).
 *
 * Assembles the broker-control toolset + near-memory thread tools, runs the
 * bounded loop (agent.ts) on the user's intent, streams each tool call/result
 * out via the injected emitters, and packages the outcome as a DispatchDecision
 * (disposition `converse` -- the agent ANSWERED, having taken whatever control
 * actions it chose). The dispatcher is a CONTROLLER, not a chat agent.
 */

import { z } from 'zod'
import type { DispatchDecision } from '../../shared/protocol'
import { chat } from '../recap/shared/openrouter-client'
import { type AgentToolCallEvent, type AgentToolResultEvent, DISPATCHER_MODEL, runAgent } from './agent'
import { buildControlDeps } from './control-deps'
import { buildControlToolset } from './control-tools'
import { appendMemoryFacts, digestTurn, readMemory } from './memory'
import type { DispatchRuntime } from './runtime'
import { listThreads, upsertThread } from './threads'
import { defineTool, type Toolset } from './tool-def'
import { buildWorkspaceToolset } from './workspace'

const DISPATCHER_SYSTEM = [
  'You are the front desk -- the live CONTROLLER for the user`s fleet of coding',
  'conversations. You are NOT a chat agent: you DRIVE the broker. You hold almost',
  'no context, so when you need to know something, USE A TOOL -- never guess.',
  '',
  'Core rules:',
  '- ALWAYS call list_conversations before claiming what is or isn`t running. Never',
  '  say "nothing is active" without checking. The roster is a tool call away.',
  '- The user`s requests are real impulses -- HONOR them. To act on a conversation,',
  '  use the tools (inject / interrupt / terminate / spawn / revive / configure /',
  '  link). Do not just describe what you would do -- do it.',
  '- terminate is IRREVERSIBLE: confirm with the user first unless they were explicit.',
  '- You have a scratch WORKSPACE (a virtual fs, workspace_* tools) to draft or',
  '  stage simple work yourself before acting. It is scratch, not storage.',
  '- Keep replies short and plain-spoken, like a good assistant talking out loud.',
  '  After acting, say what you did in one line. No markdown headers or lists.',
].join('\n')

/** Near-memory thread tools (the dispatcher`s "what am I working on" board). */
function threadTools(): Toolset {
  return {
    list_threads: defineTool({
      description: 'List your near-memory threads (what you are currently managing).',
      inputSchema: z.object({ limit: z.number().int().positive().nullable().describe('Max threads. Null = default.') }),
      idempotent: true,
      execute: a => listThreads((a as { limit: number | null }).limit ?? undefined),
    }),
    commit_thread: defineTool({
      description: 'Jot or update a near-memory thread (a short title + summary of a topic you are managing).',
      inputSchema: z.object({
        id: z.string().nullable().describe('Existing thread id to update, or null to create.'),
        title: z.string().describe('Short label.'),
        summary: z.string().nullable().describe('What it is about / current state.'),
      }),
      execute: a => {
        const args = a as { id: string | null; title: string; summary: string | null }
        return upsertThread({
          id: args.id ?? undefined,
          title: args.title,
          summary: args.summary ?? undefined,
          now: Date.now(),
        })
      },
    }),
  }
}

function buildAgentToolset(rt: DispatchRuntime): Toolset {
  return { ...buildControlToolset(buildControlDeps(rt)), ...threadTools(), ...buildWorkspaceToolset() }
}

export interface RunDispatchAgentOpts {
  /** Model override (user-switchable). Falls back to the desk default (Haiku). */
  model?: string
  /** Shared trace id so the streamed tool frames + the decision correlate. */
  traceId?: string
  signal?: AbortSignal
  userId?: string | null
  onToolCall?: (e: AgentToolCallEvent) => void
  onToolResult?: (e: AgentToolResultEvent) => void
}

/** Run the dispatcher agent loop on a free-text intent -> a DispatchDecision. */
export async function runDispatchAgent(
  intent: string,
  rt: DispatchRuntime,
  opts: RunDispatchAgentOpts = {},
): Promise<DispatchDecision> {
  const model = opts.model || DISPATCHER_MODEL
  // Read the tiny durable memory file -- the loop's only carried context.
  const memory = readMemory(opts.userId)
  const result = await runAgent(
    {
      intent,
      system: DISPATCHER_SYSTEM,
      context: memory ? `DURABLE MEMORY (your long-term notes -- trust these):\n${memory}` : undefined,
      model,
      toolset: buildAgentToolset(rt),
      signal: opts.signal,
      identity: { userId: opts.userId ?? undefined },
      onToolCall: opts.onToolCall,
      onToolResult: opts.onToolResult,
    },
    req => chat(req),
  )
  // Post-turn digest: decide what (if anything) durable to remember, fire-and-
  // forget so the user's reply is never blocked. Tool calls are NEVER recorded.
  if (result.reply) {
    digestTurn({ intent, reply: result.reply, existingMemory: memory }, req => chat(req))
      .then(facts => appendMemoryFacts(facts, Date.now(), opts.userId))
      .catch(() => {})
  }
  const decision: DispatchDecision = {
    type: 'dispatch_decision',
    decisionId: `dec_${crypto.randomUUID()}`,
    intent,
    disposition: 'converse',
    confidence: 1,
    reasoning: 'agent loop',
    reply: result.reply,
    executed: result.toolCallCount > 0,
    model: result.model,
    toolCallCount: result.toolCallCount,
    traceId: opts.traceId ?? `trc_${crypto.randomUUID()}`,
    ts: Date.now(),
  }
  if (result.touchedConversationIds[0]) decision.resultConversationId = result.touchedConversationIds[0]
  return decision
}
