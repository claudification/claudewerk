/**
 * The QUEST tool (plan §3 B4) -- the dispatcher's "go find this out and report
 * back" verb, the heart of the §0 Arr scenario.
 *
 * The dispatcher spawns a fresh worker in a project to answer a question, judging
 * the task's COMPLEXITY to pick the model tier (don't wake Opus when Sonnet does).
 * The worker is told to `send_message(to:"dispatcher")` with its findings and exit;
 * that report-back routes through the reserved sink (async-impulse.ts) and
 * re-engages the dispatcher. We park a `<pending id=qN>` block in the user's
 * living history now; the report-back mutates it to `<findings qN>`.
 */

import { z } from 'zod'
import { getUserHistory } from './history-store'
import { upsertBlock } from './living-history'
import { questModel } from './model-config'
import { resolveDeskProject } from './projects'
import { registerQuest } from './quest-registry'
import { type DispatchRuntime, spawnDeskConversation } from './runtime'
import { defineTool, type ToolContext, type Toolset } from './tool-def'

/** The opening prompt handed to the worker: do the task, report back, exit. */
function buildQuestPrompt(task: string): string {
  return [
    task,
    '',
    'When you have the answer, call the send_message tool with `to: "dispatcher"` and',
    '`message:` your findings -- concise, just the result, no preamble. Then call',
    'exit_conversation. Do NOT wait for a reply; reporting back and exiting is the job.',
  ].join('\n')
}

function shortId(): string {
  return `q_${crypto.randomUUID().slice(0, 6)}`
}

/** The spawn seam -- the live loop uses spawnDeskConversation; tests inject a stub.
 *  We spawn BY PROJECT URI (the canonical identity); the sentinel derives the
 *  filesystem location. The dispatcher never reasons in raw paths. */
export type QuestSpawn = (req: { projectUri: string; intent: string; model?: string }) => Promise<{
  conversationId: string
}>

export function questTools(rt: DispatchRuntime, spawn?: QuestSpawn): Toolset {
  // The spawn machinery accepts a project URI as its target (spawn-dispatch wraps
  // plain paths but passes URIs through). Pass the URI, not a derived path.
  const doSpawn: QuestSpawn =
    spawn ?? (req => spawnDeskConversation(rt, { target: req.projectUri, intent: req.intent, model: req.model }))
  return {
    dispatch_quest: defineTool({
      description:
        'Dispatch a NEW worker to answer a question or do a task in a project, then report back to YOU when done. Use when the answer needs hands-on work (a lookup, a check, an investigation) and no live conversation already covers it -- the §0 "check with Arr for new movies" case. Judge COMPLEXITY to set the model: "simple" (a quick lookup -> Haiku), "moderate" (a real investigation -> Sonnet), "complex" (deep/ambiguous/high-stakes -> Opus). Tell the user you dispatched it; the worker reports its findings back and you are re-engaged with the result. Returns the worker conversationId + the pending id.',
      inputSchema: z.object({
        project: z.string().describe('Project name, slug, or uri to run the quest in.'),
        task: z.string().describe('The question / task for the worker, in plain language.'),
        complexity: z
          .enum(['simple', 'moderate', 'complex'])
          .describe('Drives the model tier: simple=Haiku, moderate=Sonnet, complex=Opus.'),
      }),
      execute: async (a, ctx: ToolContext) => {
        const { project, task, complexity } = a as {
          project: string
          task: string
          complexity: 'simple' | 'moderate' | 'complex'
        }
        const dp = resolveDeskProject(project)
        if (!dp) return { error: `no project matching "${project}"` }
        // Dispatch BY PROJECT URI -- agnostic to scheme. A claude:// project hosts a
        // CC worker, an agent:// / api:// project a chat worker; the spawn machinery
        // routes by the URI. The dispatcher never reasons about a filesystem path.
        const userId = ctx.identity?.userId ?? null
        const model = questModel(complexity)
        let conversationId: string
        try {
          ;({ conversationId } = await doSpawn({ projectUri: dp.projectUri, intent: buildQuestPrompt(task), model }))
        } catch (e) {
          return { error: `dispatch failed: ${(e as Error).message}` }
        }

        const pendingId = shortId()
        registerQuest(conversationId, { userId, pendingId, intent: task, project: dp.label })
        // Park the pending block in the user's living history -- the worker's
        // report-back will mutate <pending> -> <findings> (THAT is the impulse).
        upsertBlock(
          getUserHistory(userId),
          pendingId,
          'pending',
          `${dp.label}: ${task} (worker ${conversationId.slice(0, 8)} on ${model})`,
          Date.now(),
        )
        return {
          conversationId,
          pendingId,
          project: dp.label,
          model,
          note: 'worker dispatched -- it reports its findings back to you and exits',
        }
      },
    }),
  }
}
