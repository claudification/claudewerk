/**
 * The TAILORED dispatcher toolset (plan-dispatcher-brain.md P5). The dispatcher
 * is a project-anchored routing BRAIN, so its primary tools are project-shaped --
 * `projects_overview` / `project_brief` / `recall` / `route` / `spawn_into_project`
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
import { buildControlDeps } from './control-deps'
import { buildControlToolset } from './control-tools'
import { condenseProjectNow } from './desk-memory-service'
import { lookupTools } from './lookup-tools'
import type { DispatchCommand } from './orchestrate'
import { composeProjectsOverview, type OverviewConv, type ProjectOverviewRow } from './overview'
import { getBrief, recallBriefs } from './project-memory'
import { listDeskProjects, projectKeyOf, resolveDeskProject } from './projects'
import { type QuestSpawn, questTools } from './quest-tool'
import { type DispatchRuntime, runDispatch } from './runtime'
import { defineTool, type Toolset } from './tool-def'

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

/** The fleet by project, with condensed briefs + live counts. Shared by the
 *  projects_overview tool AND the per-turn context assembly (P6). */
export function projectOverviewRows(rt: DispatchRuntime): ProjectOverviewRow[] {
  const projects = listDeskProjects()
  const briefByKey = new Map(projects.map(p => [p.key, getBrief(p.key)?.brief ?? '']))
  const convs = rt.store.getAllConversations().map(toOverviewConv)
  return composeProjectsOverview(projects, briefByKey, convs, Date.now())
}

/** The project-anchored tools -- the dispatcher's primary surface. */
function projectTools(rt: DispatchRuntime, confirmedExpensive: boolean): Toolset {
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
        const conversations = rt.store
          .getAllConversations()
          .filter(c => projectKeyOf(c.project) === dp.key && c.status !== 'ended')
          .map(c => ({
            conversationId: c.id,
            title: c.title,
            state: c.liveStatus?.state ?? 'live',
            idleMin: c.lastActivity ? Math.round((Date.now() - c.lastActivity) / 60000) : undefined,
          }))
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

    spawn_into_project: defineTool({
      description:
        'Spawn a NEW conversation inside a project (resolved by name/slug/uri), even one with no live conversations. The user asking to start work in a project is a real impulse -- honor it.',
      inputSchema: z.object({
        project: z.string().describe('Project name, slug, or uri.'),
        intent: z.string().describe('The opening task for the new conversation.'),
        profile: z.string().nullable().describe('Sentinel profile / model override, or null for the default.'),
      }),
      execute: async a => {
        const { project, intent, profile } = a as { project: string; intent: string; profile: string | null }
        const dp = resolveDeskProject(project)
        if (!dp) return { error: `no project matching "${project}"` }
        if (!dp.cwd) return { error: `project "${dp.label}" has no local filesystem path; cannot spawn into it` }
        const cmd: DispatchCommand = {
          intent,
          disposition: 'new',
          cwd: dp.cwd,
          project: dp.projectUri,
          confirmedExpensive,
        }
        if (profile) cmd.profile = profile
        const d = await runDispatch(cmd, rt)
        if (!d.resultConversationId) return { error: d.reasoning || 'spawn produced no conversation' }
        return { conversationId: d.resultConversationId, project: dp.label }
      },
    }),
  }
}

/**
 * The full dispatcher toolset: project-anchored tools (lead) + the rich control
 * verbs (actions). The generic `spawn` is dropped -- `spawn_into_project`
 * supersedes it with named-project resolution.
 */
export function buildDispatchToolset(
  rt: DispatchRuntime,
  confirmedExpensive = false,
  questSpawn?: QuestSpawn,
): Toolset {
  const { spawn: _omitGenericSpawn, ...control } = buildControlToolset(buildControlDeps(rt, confirmedExpensive))
  return { ...projectTools(rt, confirmedExpensive), ...questTools(rt, questSpawn), ...lookupTools(rt), ...control }
}
