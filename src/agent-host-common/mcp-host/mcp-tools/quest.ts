/**
 * QUEST substrate agent tools (plan-quest-engine §4e) -- the verb family a quest
 * leg (or the intake conversation) uses to author + steer a quest. Every action
 * POSTs one op-envelope to the broker `/api/quest` route (Bearer secret), which
 * relays it to the SENTINEL that owns the project's quest tree. THE ARTIFACT IS
 * THE API; §14: no engine state lives anywhere but the manifest + board cards.
 *
 * Eight self-describing verbs, matching the project-board/nightshift idiom:
 *   create_quest · update_quest · quest_log_append · get_quest ·
 *   list_quests · quest_status · abort_quest · pause_quest
 *
 * Shared plumbing (post/err/parseJson/PROJECT_PROP) lives in quest-tool-lib.ts
 * (a leaf module -- no cycle); the verb defs are split across quest-verbs-*.ts.
 */

import { wsToHttpUrl } from '../../../shared/ws-url'
import { debug } from '../debug'
import type { QuestPost } from './quest-tool-lib'
import { questReadVerbs } from './quest-verbs-read'
import { questWriteVerbs } from './quest-verbs-write'
import type { McpToolContext, ToolDef } from './types'

export function registerQuestTools(ctx: McpToolContext): Record<string, ToolDef> {
  // Mirrors the nightshift MCP post() by design (same broker-route idiom).
  const post: QuestPost = async body => {
    // fallow-ignore-next-line code-duplication
    if (ctx.noBroker || !ctx.brokerUrl)
      return { content: [{ type: 'text', text: 'Error: no broker connection' }], isError: true }
    const url = `${wsToHttpUrl(ctx.brokerUrl)}/api/quest`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ctx.brokerSecret) headers.Authorization = `Bearer ${ctx.brokerSecret}`
    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!json.ok)
        return { content: [{ type: 'text', text: `quest error: ${json.error || res.status}` }], isError: true }
      debug(`[channel] quest ${String(body.op)} ok`)
      return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `quest request failed: ${(e as Error).message}` }], isError: true }
    }
  }

  return { ...questWriteVerbs(ctx, post), ...questReadVerbs(post) }
}
