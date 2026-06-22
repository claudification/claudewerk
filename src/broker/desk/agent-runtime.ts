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
import { buildDispatchToolset, projectOverviewRows } from './dispatch-tools'
import { consolidateIfDue, getUserHistory, refreshLiveBlocks } from './history-store'
import { appendTurn, toMessages } from './living-history'
import { readMemory } from './memory'
import type { DispatchRuntime } from './runtime'
import { listThreads, upsertThread } from './threads'
import { defineTool, type Toolset } from './tool-def'
import { buildWorkspaceToolset } from './workspace'

const DISPATCHER_SYSTEM = [
  'You are the FRONT DESK -- the routing BRAIN for the user`s fleet of coding',
  'conversations, spread across PROJECTS. PROJECTS are your #1 anchor: you think',
  'in projects first, conversations second. You are NOT a chat agent: you DRIVE',
  'the broker. You hold almost no context, so when you need to know something,',
  'USE A TOOL -- never guess.',
  '',
  'Your message history carries live XML STATE BLOCKS you can read directly:',
  '  <fleet> -- the fleet by project (live/working/needs-you counts), refreshed each turn.',
  '  <briefs> -- condensed per-project memory (detail via project_brief / recall).',
  '  <notes> -- durable facts about the user. <memory> -- your rolling recollection.',
  '  <pending id=..> -- async work you dispatched and are awaiting; when it reports',
  '  back it becomes <findings id=..>, which is your cue to continue that thread.',
  'Read the blocks instead of re-asking; they are already current.',
  '',
  'Core rules:',
  '- For "what is going on" / status / overview, call projects_overview -- it gives',
  '  the fleet BY PROJECT with your condensed memory. Prefer it over list_conversations.',
  '- For one project, call project_brief; to search your memory, call recall.',
  '- The user`s requests are real impulses -- HONOR them. To start work in a project',
  '  use spawn_into_project; to place an ambiguous request use route; to act on a',
  '  conversation use inject / interrupt / terminate / configure / revive.',
  '  Do not just describe what you would do -- do it.',
  '- terminate is IRREVERSIBLE: confirm with the user first unless they were explicit.',
  '- You have a scratch WORKSPACE (a virtual fs, workspace_* tools) to draft or',
  '  stage simple work yourself before acting. It is scratch, not storage.',
  '- Keep replies short and plain-spoken, like a good assistant talking out loud.',
  '  After acting, say what you did in one line.',
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
  return { ...buildDispatchToolset(rt), ...threadTools(), ...buildWorkspaceToolset() }
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

/**
 * Run ONE dispatcher IMPULSE against the user's persistent LIVING HISTORY.
 *
 * The history is OURS to rewrite: refresh the volatile state blocks from the
 * current fleet, append the user turn, run the bounded tool loop over the whole
 * rendered history, append the reply, then fold if due. Memory forms by phase-out
 * (consolidate), NOT a per-turn digest -- so the hot path stays one LLM loop.
 */
export async function runDispatchAgent(
  intent: string,
  rt: DispatchRuntime,
  opts: RunDispatchAgentOpts = {},
): Promise<DispatchDecision> {
  const model = opts.model || DISPATCHER_MODEL
  const now = Date.now()
  const history = getUserHistory(opts.userId)
  // REFRESH the live blocks in place (fleet/briefs/notes), then append the impulse.
  refreshLiveBlocks(history, { rows: projectOverviewRows(rt), durableNotes: readMemory(opts.userId), now })
  appendTurn(history, 'user', intent, now)

  const result = await runAgent(
    {
      intent,
      system: DISPATCHER_SYSTEM,
      seedMessages: toMessages(history),
      model,
      toolset: buildAgentToolset(rt),
      signal: opts.signal,
      identity: { userId: opts.userId ?? undefined },
      onToolCall: opts.onToolCall,
      onToolResult: opts.onToolResult,
    },
    req => chat(req),
  )
  // Append the reply as the assistant turn, then consolidate-if-due (gated: rarely
  // fires, §8a). Fire-and-forget so the rare fold never delays the user's reply.
  if (result.reply) {
    appendTurn(history, 'assistant', result.reply, Date.now())
    consolidateIfDue(history, opts.userId, Date.now(), req => chat(req)).catch(() => {})
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
