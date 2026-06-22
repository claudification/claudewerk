/**
 * The dispatcher's ONE tool set (plan-dispatcher-build.md §9.4c) -- the single
 * source that drives BOTH the OpenAI Realtime voice session (schemas derived in
 * voice-tools.ts) AND the future agent-core text loop (the bound Toolset).
 *
 * Two layers:
 *   - `dispatchToolSchemas` -- deps-FREE { description, inputSchema:zod } per
 *     tool. The schema source of truth; the voice contract derives from it.
 *   - `buildDispatchToolset(deps)` -- binds each schema to a signal-aware
 *     `execute` over injected backend deps -> an agent-core-shaped `Toolset`.
 *
 * Optional fields are `.nullable()` (NOT `.optional()`) so OpenAI strict mode's
 * "required lists every property" rule is satisfied by the derived schema.
 */

import { z } from 'zod'
import type { DispatchDecision, DispatchDisposition, DispatchThread } from '../../shared/protocol'
import type { ToolSchema } from './realtime-schema'
import { defineTool, type ToolContext, type Toolset } from './tool-def'

// ─── Schemas (single source, deps-free) ─────────────────────────────

const dispatchInput = z.object({
  intent: z.string().describe('What the user wants done, in their words.'),
  target: z.string().nullable().describe('Explicit conversationId or project, when named. Else null.'),
  disposition: z
    .enum(['new', 'route', 'revive'])
    .nullable()
    .describe('Hard override of the routing decision. Usually null -- let the dispatcher decide.'),
})
const conversationSelectInput = z.object({
  decisionId: z.string().describe('The dispatch decision being answered.'),
  conversationId: z.string().describe('The conversation the user chose from the candidate cards.'),
})
const confirmExpensiveInput = z.object({
  decisionId: z.string().describe('The held decision being confirmed.'),
  confirm: z.boolean().describe('true to proceed despite the cost, false to cancel.'),
})
const controlScreenInput = z.object({
  action: z.enum(['open_modal', 'close_modal', 'navigate']),
  target: z.string().nullable().describe('Modal name or navigation target. Null for close_modal.'),
})
const listThreadsInput = z.object({
  limit: z.number().int().positive().nullable().describe('Max threads to return. Null = default.'),
})
const commitThreadInput = z.object({
  id: z.string().nullable().describe('Existing thread id to update, or null to create.'),
  title: z.string().describe('Short label for the thread.'),
  summary: z.string().nullable().describe('Near-memory text: what this thread is about / current state.'),
})
const subscribeProjectInput = z.object({
  project: z.string().describe('Project to (un)subscribe to the status feed.'),
  subscribe: z.boolean().describe('true to subscribe (expose to dispatch), false to unsubscribe.'),
})

const DESCRIPTIONS = {
  dispatch:
    "Route the user's intent to the fleet. The dispatcher decides whether to spawn a NEW conversation, route into an EXISTING one, or revive an ENDED one. Pass only intent to let it decide.",
  conversation_select:
    'When the dispatcher asked the user to choose between candidate conversations, call this with the conversationId they picked.',
  confirm_expensive:
    'When the dispatcher warned a route is very expensive (large context, cold cache, or Opus), call this with the user yes/no.',
  control_screen: 'Drive the dashboard by voice: open/close a modal or navigate to a view.',
  list_threads:
    "List the dispatcher's threads -- its near-memory of what it is managing (topic, summary, conversations used + when).",
  commit_thread: 'Create or update a thread in the near-memory with a title and summary.',
  subscribe_project: "Subscribe (or unsubscribe) a project to the dispatcher's status feed.",
} as const

export type DispatchToolName = keyof typeof DESCRIPTIONS

/** Deps-free schema source -- the voice contract derives from this. */
export const dispatchToolSchemas: Record<DispatchToolName, ToolSchema> = {
  dispatch: { description: DESCRIPTIONS.dispatch, inputSchema: dispatchInput },
  conversation_select: { description: DESCRIPTIONS.conversation_select, inputSchema: conversationSelectInput },
  confirm_expensive: { description: DESCRIPTIONS.confirm_expensive, inputSchema: confirmExpensiveInput },
  control_screen: { description: DESCRIPTIONS.control_screen, inputSchema: controlScreenInput },
  list_threads: { description: DESCRIPTIONS.list_threads, inputSchema: listThreadsInput },
  commit_thread: { description: DESCRIPTIONS.commit_thread, inputSchema: commitThreadInput },
  subscribe_project: { description: DESCRIPTIONS.subscribe_project, inputSchema: subscribeProjectInput },
}

// ─── Bound toolset (agent-core-shaped) ──────────────────────────────

/** Backend the tools call into. Injected so the tool set is runtime-agnostic
 *  and unit-testable; the broker-integration layer supplies the real impls. */
export interface DispatchToolDeps {
  dispatch(
    cmd: { intent: string; target?: string; disposition?: DispatchDisposition; confirmedExpensive?: boolean },
    ctx: ToolContext,
  ): Promise<DispatchDecision>
  confirmExpensive(decisionId: string, confirm: boolean, ctx: ToolContext): Promise<DispatchDecision>
  controlScreen(action: 'open_modal' | 'close_modal' | 'navigate', target: string | null): Promise<unknown>
  listThreads(limit: number | null): DispatchThread[]
  commitThread(input: { id: string | null; title: string; summary: string | null }): string
  subscribeProject(project: string, subscribe: boolean): Promise<unknown>
}

/** Bind the schema set to signal-aware executors over `deps`. The result is an
 *  agent-core-shaped `Toolset` (swap the local defineTool for the real import
 *  + buildHarness to run it as a text agent loop). */
export function buildDispatchToolset(deps: DispatchToolDeps): Toolset {
  return {
    dispatch: defineTool({
      description: DESCRIPTIONS.dispatch,
      inputSchema: dispatchInput,
      execute: (args, ctx) =>
        deps.dispatch(
          {
            intent: args.intent,
            target: args.target ?? undefined,
            disposition: args.disposition ?? undefined,
          },
          ctx,
        ),
    }),
    conversation_select: defineTool({
      description: DESCRIPTIONS.conversation_select,
      inputSchema: conversationSelectInput,
      execute: (args, ctx) => deps.dispatch({ intent: '', target: args.conversationId, disposition: 'route' }, ctx),
    }),
    confirm_expensive: defineTool({
      description: DESCRIPTIONS.confirm_expensive,
      inputSchema: confirmExpensiveInput,
      idempotent: true,
      execute: (args, ctx) => deps.confirmExpensive(args.decisionId, args.confirm, ctx),
    }),
    control_screen: defineTool({
      description: DESCRIPTIONS.control_screen,
      inputSchema: controlScreenInput,
      execute: args => deps.controlScreen(args.action, args.target),
    }),
    list_threads: defineTool({
      description: DESCRIPTIONS.list_threads,
      inputSchema: listThreadsInput,
      idempotent: true,
      execute: args => deps.listThreads(args.limit),
    }),
    commit_thread: defineTool({
      description: DESCRIPTIONS.commit_thread,
      inputSchema: commitThreadInput,
      execute: args => deps.commitThread({ id: args.id, title: args.title, summary: args.summary }),
    }),
    subscribe_project: defineTool({
      description: DESCRIPTIONS.subscribe_project,
      inputSchema: subscribeProjectInput,
      execute: args => deps.subscribeProject(args.project, args.subscribe),
    }),
  }
}
