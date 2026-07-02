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
import { MEMORY_BLOCK_ID } from './consolidate'
import { buildDispatchToolset, projectOverviewRows } from './dispatch-tools'
import { consolidateIfDue, getUserHistory, markDirty, recordTurn, refreshLiveBlocks } from './history-store'
import { appendTurn, getBlock, toMessages } from './living-history'
import { readMemory, readSystemAppend } from './memory'
import { activeContextRows } from './overview'
import type { QuestSpawn } from './quest-tool'
import type { DispatchRuntime } from './runtime'
import { buildSotuBlockBody } from './sotu-context'
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
  '  <threads> -- your SHORT-TERM memory: what you are doing RIGHT NOW (most-recent',
  '  first). This is your nearest, freshest memory -- trust it over older context.',
  '  Keep it current with commit_thread; full detail is in list_threads.',
  '  <briefs> -- condensed per-project memory (detail via project_brief / recall).',
  '  <sotu> -- the State of the Union: per-project distilled narrative + git',
  '  escalation alerts (at-risk/unpushed/stalled) + CONTENDED collisions. This is',
  '  the fleet TRUTH -- ground status answers in it. Full detail + fresh regen via',
  '  the state_of_union tool; quantitative cost/token numbers via fleet_sheaf.',
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
  '  "check with arr what movies released" -- ALWAYS dispatch_quest, NEVER route',
  '  for a question. Pick complexity: simple=a quick lookup,',
  '  moderate=a real investigation, complex=deep/ambiguous. Then tell the user you',
  '  dispatched it.',
  '- HYPOTHETICALS: "if I asked you to...", "how would you...", "what would you do',
  '  if..." are questions ABOUT your behavior, not requests to ACT. Answer them by',
  '  explaining what you WOULD do -- do NOT actually dispatch or execute. Only act',
  '  when the user gives a direct instruction, not a hypothetical one.',
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
  '- To START NEW work in a project (a question, a task, or long-running work) use',
  '  dispatch_quest -- it resolves the project by name/slug/uri and spawns a worker',
  '  even when the project has no live conversation; the worker reports back to you',
  '  and exits. To act on an EXISTING conversation use inject / interrupt /',
  '  terminate / configure / revive. Do not just describe what you would do -- do it.',
  '- terminate is IRREVERSIBLE: confirm with the user first unless they were explicit.',
  '- COST LADDER -- cheapest action first, ALWAYS:',
  '  1. "what is it about / what did it do / check on it" = READ-ONLY. Use',
  '     search_transcripts or project_brief. ZERO agent cost. NEVER revive or inject',
  '     just to find out what a conversation did.',
  '  2. "ask it something / send it a message" = inject (if connected). If the',
  '     conversation is ACTIVE (running right now), injection is cheap -- its context',
  '     is already loaded, so injecting is just one new turn. If it is IDLE with an',
  '     interactionCost tag, warn the user: resuming re-processes the full context.',
  '  3. "wake it up / continue / resume the work" = revive. Expensive. Only on explicit',
  '     user request, NEVER as a default. If the user says "check on it", that is NOT',
  '     "revive it".',
  '  project_brief returns an interactionCost tag ("moderate", "expensive", "very',
  '  expensive") and a costNote on IDLE conversations only. Active conversations have',
  '  no tag (they are cheap to inject into). A conversation tagged "very expensive"',
  '  must NEVER be injected or revived without explicit user go-ahead.',
  '- You have a scratch WORKSPACE (a virtual fs, workspace_* tools) to draft or',
  '  stage simple work yourself before acting. It is scratch, not storage.',
  '- Keep replies short and plain-spoken, like a good assistant talking out loud.',
  '  After acting, say what you did in one line.',
].join('\n')

function buildSystemPrompt(override?: string): string {
  const base = override || DISPATCHER_SYSTEM
  const append = readSystemAppend().trim()
  return append ? `${base}\n\n${append}` : base
}

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

/** PROGRESSIVE MEMORY (plan-dispatcher-living-history.md B10). The dispatcher's own
 *  long-term memory (durable `<notes>` + the rolling `<memory>` block) is kept SMALL
 *  in the hot window -- consolidation prunes it as it ages. This tool pages the FULL
 *  current memory back in ON DEMAND, so the dispatcher can answer about something that
 *  has aged out of context instead of guessing. (Project memory has its own pagers:
 *  recall / project_brief / projects_overview.) */
function memoryTools(userId: string | null | undefined): Toolset {
  return {
    read_memory: defineTool({
      description:
        'Re-read your FULL long-term memory about the user -- the durable notes plus your rolling recollection. Use when you need a standing fact, preference, or past decision that may have aged out of the live context window. Returns what you remember; it does not search project briefs (use recall for that).',
      inputSchema: z.object({}),
      idempotent: true,
      execute: () => ({
        notes: readMemory(userId),
        memory: getBlock(getUserHistory(userId), MEMORY_BLOCK_ID)?.content ?? '',
      }),
    }),
  }
}

function buildAgentToolset(
  rt: DispatchRuntime,
  confirmedExpensive: boolean,
  userId: string | null | undefined,
  questSpawn?: QuestSpawn,
): Toolset {
  return {
    ...buildDispatchToolset(rt, confirmedExpensive, questSpawn),
    ...threadTools(),
    ...memoryTools(userId),
    ...buildWorkspaceToolset(),
  }
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
  /** Record the user `intent` into the VIEWABLE transcript ring (A0). Default true.
   *  The async impulse (deliverDispatcherReport) sets this false: its intent is a
   *  synthetic "a worker reported back" trigger, not a turn the user typed -- only
   *  the dispatcher's relayed reply should land in the viewable transcript. */
  recordUserTurn?: boolean
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
  // REFRESH the live blocks in place (fleet/threads/briefs/notes), then append the
  // impulse. Decay prune: stale quiet projects fade OUT of the per-turn window
  // (still in storage + reachable via projects_overview / project_brief / recall).
  // Threads = short-term memory ("what we're doing now"), folded into context here.
  const contextRows = activeContextRows(projectOverviewRows(rt))
  refreshLiveBlocks(history, {
    rows: contextRows,
    threads: listThreads(),
    durableNotes: readMemory(opts.userId),
    // The State of the Union, always in context (zero-LLM read of the current
    // chronicle + live queue; the SOTU engine owns freshness).
    sotu: buildSotuBlockBody(contextRows, now),
    now,
  })
  appendTurn(history, 'user', intent, now)
  // Mirror the real user turn into the viewable transcript ring (A0). The async
  // impulse opts out -- its intent is a synthetic report-back trigger, not a turn.
  if (opts.recordUserTurn !== false) recordTurn(opts.userId, 'user', intent, now)

  const result = await runAgent(
    {
      intent,
      system: buildSystemPrompt(opts.systemOverride),
      seedMessages: toMessages(history),
      model,
      toolset: buildAgentToolset(rt, opts.confirmedExpensive ?? false, opts.userId, opts.questSpawn),
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
    const replyTs = Date.now()
    appendTurn(history, 'assistant', result.reply, replyTs)
    recordTurn(opts.userId, 'assistant', result.reply, replyTs) // viewable transcript (A0)
    consolidateIfDue(history, opts.userId, Date.now(), req => chat(req)).catch(() => {})
  }
  // Persist the mutated state (turns + refreshed blocks + transcript) -- debounced,
  // so this survives a broker restart (Slice A). Async folds re-mark inside the store.
  markDirty(opts.userId)
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
