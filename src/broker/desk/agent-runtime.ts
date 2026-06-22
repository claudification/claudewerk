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
import type { QuestSpawn } from './quest-tool'
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
  '- "CHECK WITH <project>" / "ask <project>" / "find out from <project>" / any',
  '  question you need a project to ANSWER -> call dispatch_quest with that exact',
  '  project name. It spawns a worker IN that project that does the work and reports',
  '  back to you; you are re-engaged with the result. This is the #1 path for',
  '  "check with arr what movies released" -- ALWAYS dispatch_quest, NEVER route or',
  '  spawn_into_project for a question. Pick complexity: simple=a quick lookup,',
  '  moderate=a real investigation, complex=deep/ambiguous. Then tell the user you',
  '  dispatched it.',
  '- CRITICAL: the <fleet> block lists ONLY projects that have LIVE conversations.',
  '  Most registered projects are QUIET (no live conv) and will NOT appear there --',
  '  e.g. a movie-tracker "arr". NEVER conclude a named project "does not exist"',
  '  from its absence in <fleet>. ALWAYS call dispatch_quest with the name the user',
  '  gave FIRST -- the tool resolves against ALL registered projects. ONLY if it',
  '  returns an error like "no project matching" do you ask the user to clarify.',
  '  Do NOT pre-emptively refuse, and NEVER spawn into an unresolved/default project.',
  '- For "what is going on" / status / overview, call projects_overview -- it gives',
  '  the fleet BY PROJECT with your condensed memory. Prefer it over list_conversations.',
  '- For one project, call project_brief; to search your memory, call recall; to',
  '  look something up across past conversations, call search_transcripts (cheap,',
  '  prefer it over waking a conversation).',
  '- To START NEW long-running work in a project (not a question) use',
  '  spawn_into_project; to act on an existing conversation use inject / interrupt /',
  '  terminate / configure / revive. Do not just describe what you would do -- do it.',
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

function buildAgentToolset(rt: DispatchRuntime, confirmedExpensive: boolean, questSpawn?: QuestSpawn): Toolset {
  return { ...buildDispatchToolset(rt, confirmedExpensive, questSpawn), ...threadTools(), ...buildWorkspaceToolset() }
}

export interface RunDispatchAgentOpts {
  /** Model override (user-switchable). Falls back to the desk default (Haiku). */
  model?: string
  /** Shared trace id so the streamed tool frames + the decision correlate. */
  traceId?: string
  signal?: AbortSignal
  userId?: string | null
  /** The user explicitly authorized expensive actions this turn (cost gate, B5).
   *  When false a very-expensive wake is surfaced for confirmation, not executed. */
  confirmedExpensive?: boolean
  /** Override the quest worker spawn (debug harness DRY-RUN: capture the project
   *  URI + model the dispatcher WOULD dispatch into, without launching a worker). */
  questSpawn?: QuestSpawn
  /** Override the dispatcher system prompt (debug harness: iterate prompt variants
   *  live via REST without rebuilding the broker). Defaults to DISPATCHER_SYSTEM. */
  systemOverride?: string
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
      system: opts.systemOverride || DISPATCHER_SYSTEM,
      seedMessages: toMessages(history),
      model,
      toolset: buildAgentToolset(rt, opts.confirmedExpensive ?? false, opts.questSpawn),
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
