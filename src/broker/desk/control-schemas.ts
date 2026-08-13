/**
 * The dispatcher's BROKER-CONTROL tool schemas (plan-dispatcher-build.md §11).
 *
 * Deps-free zod schemas + descriptions for the rich control surface the agent
 * loop drives: list / inject / interrupt / terminate / spawn / revive /
 * configure / link / unlink / read_events. This is the "almost the whole broker"
 * toolset Jonas asked for. `list_conversations` is ALWAYS available + ungated.
 *
 * Optionals are `.nullable()` (NOT `.optional()`) so the same schema also
 * satisfies OpenAI strict mode if these tools are ever offered to the voice
 * session (the one-toolset-two-drivers seam, §9.4c).
 */

import { z } from 'zod'
import type { ToolSchema } from './realtime-schema'

const listInput = z.object({
  status: z.enum(['live', 'ended', 'all']).nullable().describe('Filter by lifecycle. Null = live.'),
  filter: z.string().nullable().describe('Case-insensitive substring match on title/project. Null = no filter.'),
})
const conversationIdInput = z.object({
  conversationId: z.string().describe('Target conversation id (from list_conversations).'),
})
const injectInput = z.object({
  conversationId: z.string().describe('Conversation to inject the message into.'),
  message: z.string().describe('The message text to deliver to that conversation.'),
})
const terminateInput = z.object({
  conversationId: z.string().describe('Conversation to end.'),
  reason: z.string().nullable().describe('Why (audited). Null for none.'),
})
const spawnInput = z.object({
  intent: z.string().describe("The new conversation's opening task, in the user's words."),
  project: z.string().nullable().describe('Project to spawn under. Null = the host default.'),
  profile: z.string().nullable().describe('Sentinel profile. Null = default.'),
  worktree: z.string().nullable().describe('Worktree/branch name to spawn into. Null = no worktree.'),
})
const configureInput = z.object({
  conversationId: z.string().describe('Conversation to reconfigure.'),
  model: z.string().nullable().describe('New model, or null to leave.'),
  effort: z.enum(['low', 'medium', 'high', 'default']).nullable().describe('New effort, or null.'),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'bypassPermissions', 'plan'])
    .nullable()
    .describe('New permission mode, or null.'),
})
const linkInput = z.object({
  fromConversationId: z.string().describe('One side of the link.'),
  toConversationId: z.string().describe('The other side -- they can message each other after linking.'),
})
const readEventsInput = z.object({
  conversationId: z.string().describe('Conversation whose recent events to read.'),
  limit: z.number().int().positive().nullable().describe('Max events. Null = default.'),
})

const D = {
  list_conversations:
    'ALWAYS AVAILABLE. List the fleet of conversations (id, address, title, project, status, live-state, idle, context size). Use this first whenever the user asks what is going on / to list anything. TWO HANDLES PER ROW, do not mix them up: `id` is the raw id you pass to read_transcript / read_events, and `address` is the canonical `project:conversation` name -- the one to say out loud, and the only one a watch_conversations pattern is written against.',
  inject: 'Send a message INTO a live conversation (the user wants to tell an agent something).',
  interrupt: 'Stop a conversation mid-turn (it is doing the wrong thing / the user wants to redirect it now).',
  terminate: 'End a conversation. IRREVERSIBLE -- confirm with the user first unless they were explicit.',
  spawn: 'Start a NEW conversation to do work. Worktree-correct by construction.',
  revive: 'Reopen an ENDED conversation (reuses its id + transcript).',
  configure: "Change a conversation's model / effort / permission mode.",
  link: 'Link two conversations so they can message each other.',
  unlink: 'Remove the link between two conversations.',
  read_events: "Read a conversation's recent lifecycle/tool events (to see what it has been doing).",
} as const

export type ControlToolName = keyof typeof D

/** Deps-free schema source for the control tools. */
export const controlToolSchemas: Record<ControlToolName, ToolSchema> = {
  list_conversations: { description: D.list_conversations, inputSchema: listInput },
  inject: { description: D.inject, inputSchema: injectInput },
  interrupt: { description: D.interrupt, inputSchema: conversationIdInput },
  terminate: { description: D.terminate, inputSchema: terminateInput },
  spawn: { description: D.spawn, inputSchema: spawnInput },
  revive: { description: D.revive, inputSchema: conversationIdInput },
  configure: { description: D.configure, inputSchema: configureInput },
  link: { description: D.link, inputSchema: linkInput },
  unlink: { description: D.unlink, inputSchema: linkInput },
  read_events: { description: D.read_events, inputSchema: readEventsInput },
}
