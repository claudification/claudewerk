/**
 * The TAILORED dispatcher toolset (plan-dispatcher-brain.md P5). The dispatcher
 * is a project-anchored routing BRAIN, so its primary tools are project-shaped --
 * `projects_overview` / `project_brief` / `recall` / `route` / `dispatch_quest`
 * -- backed by the condensed memory engine (P3), NOT the raw broker verbs 1:1.
 * The rich control verbs (inject / interrupt / terminate / configure / revive /
 * link / read_events / list_conversations) remain available for ACTIONS (Jonas:
 * "almost the whole broker"), but the project tools lead.
 *
 * Bound to the live runtime; the project tools are thin wrappers over the pure
 * composer (overview.ts) + the memory store + the orchestrator (runDispatch).
 */

import { z } from 'zod'
import type { Conversation, DispatchDecision } from '../../shared/protocol'
import { sendPushToAll } from '../push'
import { awarenessTools } from './awareness-tools'
import { buildControlDeps } from './control-deps'
import { buildControlToolset } from './control-tools'
import { computeCostSignal } from './cost'
import { condenseProjectNow } from './desk-memory-service'
import { lookupTools } from './lookup-tools'
import type { DispatchCommand } from './orchestrate'
import { composeProjectsOverview, type OverviewConv, type ProjectOverviewRow } from './overview'
import { getBrief, recallBriefs } from './project-memory'
import { listDeskProjects, projectKeyOf, resolveDeskProject } from './projects'
import { type QuestSpawn, questTools } from './quest-tool'
import { readTranscriptTool } from './read-transcript-tool'
import { type DispatchRuntime, runDispatch } from './runtime'
import { defineTool, type Toolset } from './tool-def'

function contextTokensOf(c: Conversation): number | undefined {
  const tu = c.tokenUsage
  return tu ? tu.input + tu.cacheCreation + tu.cacheRead : undefined
}

function toOverviewConv(c: Conversation): OverviewConv {
  const o: OverviewConv = { projectKey: projectKeyOf(c.project), ended: c.status === 'ended' }
  if (c.liveStatus?.state) o.liveState = c.liveStatus.state
  if (c.lastActivity) o.lastActivity = c.lastActivity
  return o
}

/** Compact decision view for the model (it never needs the full wire shape). */
function summarizeDecision(d: DispatchDecision) {
  const out: Record<string, unknown> = { disposition: d.disposition, executed: d.executed, reasoning: d.reasoning }
  if (d.target) out.target = d.target
  if (d.reply) out.reply = d.reply
  if (d.resultConversationId) out.conversationId = d.resultConversationId
  if (d.awaitingConfirmation) out.awaitingConfirmation = true
  if (d.candidates?.length) out.candidates = d.candidates
  if (d.cost) out.cost = d.cost
  return out
}

/** The fleet by project, with condensed briefs + live counts, ordered by decayed
 *  recency. Shared by the projects_overview tool AND the per-turn context assembly
 *  (the latter prunes stale quiet projects via activeContextRows). Quiet projects
 *  decay from their brief's updatedAt -- the last genuine fleet event for them. */
export function projectOverviewRows(rt: DispatchRuntime): ProjectOverviewRow[] {
  const projects = listDeskProjects()
  const briefByKey = new Map<string, string>()
  const recencyByKey = new Map<string, number>()
  for (const p of projects) {
    const b = getBrief(p.key)
    briefByKey.set(p.key, b?.brief ?? '')
    if (b?.updatedAt) recencyByKey.set(p.key, b.updatedAt)
  }
  const convs = rt.store.getAllConversations().map(toOverviewConv)
  return composeProjectsOverview(projects, briefByKey, convs, Date.now(), recencyByKey)
}

/** The project-anchored tools -- the dispatcher's primary surface. */
function projectTools(rt: DispatchRuntime): Toolset {
  return {
    projects_overview: defineTool({
      description:
        'The fleet BY PROJECT: every known project with its condensed brief and live / working / needs-you counts. This is what to call for "what is going on" or a status overview -- prefer it over list_conversations.',
      inputSchema: z.object({}),
      idempotent: true,
      execute: () => projectOverviewRows(rt),
    }),

    project_brief: defineTool({
      description:
        'The condensed durable memory for ONE project plus its live conversations. Accepts a project name, slug, or uri. If the project has not been learned yet, it backfills from recaps on the spot.',
      inputSchema: z.object({ project: z.string().describe('Project name, slug, or uri.') }),
      execute: async a => {
        const { project } = a as { project: string }
        const dp = resolveDeskProject(project)
        if (!dp) return { error: `no project matching "${project}"` }
        let brief = getBrief(dp.key)
        if (!brief?.brief) {
          await condenseProjectNow(dp.key, dp.projectUri, dp.label)
          brief = getBrief(dp.key)
        }
        const now = Date.now()
        const conversations = rt.store
          .getAllConversations()
          .filter(c => projectKeyOf(c.project) === dp.key && c.status !== 'ended')
          .map(c => {
            const idleMs = c.lastActivity ? now - c.lastActivity : undefined
            const isActive = c.status === 'active'
            const cost = computeCostSignal({ contextTokens: contextTokensOf(c), idleMs, model: c.model, isActive })
            const entry: Record<string, unknown> = {
              conversationId: c.id,
              title: c.title,
              state: c.liveStatus?.state ?? 'live',
              idleMin: idleMs !== undefined ? Math.round(idleMs / 60000) : undefined,
            }
            if (cost.tier !== 'cheap') {
              entry.interactionCost = cost.tier.replace('_', ' ')
              entry.costNote = cost.note
            }
            return entry
          })
        return {
          project: dp.label,
          projectUri: dp.projectUri,
          brief: brief?.brief || '(nothing learned yet)',
          conversations,
        }
      },
    }),

    recall: defineTool({
      description:
        'Search your condensed project memory by keyword (FTS over the durable briefs). Returns the matching projects and what you remember about them.',
      inputSchema: z.object({ query: z.string().describe('What to recall (keywords).') }),
      idempotent: true,
      execute: a =>
        recallBriefs((a as { query: string }).query).map(b => ({
          project: b.label,
          projectUri: b.projectUri,
          brief: b.brief,
        })),
    }),

    route: defineTool({
      description:
        'Make a ROUTING decision for an intent: resume a live conversation, revive an ended one, spawn fresh, or ask. Optionally scope to a project. Use this to act on a work request when you are unsure where it belongs.',
      inputSchema: z.object({
        intent: z.string().describe('The work request to route.'),
        project: z.string().nullable().describe('Scope to this project, or null.'),
      }),
      execute: async a => {
        const { intent, project } = a as { intent: string; project: string | null }
        const cmd: DispatchCommand = { intent }
        if (project) {
          const dp = resolveDeskProject(project)
          if (dp) {
            cmd.project = dp.projectUri
            if (dp.cwd) cmd.cwd = dp.cwd
          }
        }
        return summarizeDecision(await runDispatch(cmd, rt))
      },
    }),
  }
}

/**
 * The full dispatcher toolset: project-anchored tools (lead) + the rich control
 * verbs (actions). EVERY spawn path carries the report-back contract: the only
 * spawn verb is `dispatch_quest` (quest registration + report-back prompt +
 * parked <pending> block). The generic `spawn` and the fire-and-forget
 * `spawn_into_project` are both dropped -- `dispatch_quest` resolves a named /
 * slug / uri project and spawns into it even with zero live conversations.
 */
function notifyTool(rt: DispatchRuntime): Toolset {
  return {
    notify_user: defineTool({
      description:
        "Send a push notification to the user's phone/browser. Use freely -- for async quest results, status updates, or anything the user should see even if they're not watching the dashboard.",
      inputSchema: z.object({
        message: z.string().describe('Notification body.'),
        title: z.string().optional().describe('Optional title (defaults to "Front Desk").'),
      }),
      execute: async a => {
        const { message, title } = a as { message: string; title?: string }
        const heading = title || 'Front Desk'
        const wsPayload = JSON.stringify({ type: 'notification', title: heading, body: message, timestamp: Date.now() })
        for (const ws of rt.store.getSubscribers()) {
          try {
            ws.send(wsPayload)
          } catch {
            /* dead socket */
          }
        }
        const push = await sendPushToAll({ title: heading, body: message })
        return { delivered: push.sent > 0 || push.failed > 0 ? 'yes' : 'no push subscriptions (WS only)' }
      },
    }),
  }
}

export function buildDispatchToolset(
  rt: DispatchRuntime,
  confirmedExpensive = false,
  questSpawn?: QuestSpawn,
): Toolset {
  const { spawn: _omitGenericSpawn, ...control } = buildControlToolset(buildControlDeps(rt, confirmedExpensive))
  return {
    ...projectTools(rt),
    ...questTools(rt, questSpawn),
    ...lookupTools(rt),
    ...readTranscriptTool(rt),
    ...awarenessTools(),
    ...notifyTool(rt),
    ...control,
  }
}
