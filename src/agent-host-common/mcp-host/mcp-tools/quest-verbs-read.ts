/**
 * QUEST read verbs (plan-quest-engine §4e): get_quest, list_quests,
 * quest_status. See quest.ts for the shared post/err plumbing. Reads need only
 * `files:read`; the SENTINEL computes the §4c predicate from disk (§11 -- the
 * completion claim is COMPUTED, never asserted). get_quest + quest_status share
 * the project+petname shape via petnameVerb (no-duplication).
 */

import { questErr as err, PROJECT_PROP, petnameVerb, type QuestPost } from './quest-tool-lib'
import type { ToolDef } from './types'

type Params = Record<string, string>

export function questReadVerbs(post: QuestPost): Record<string, ToolDef> {
  return {
    get_quest: petnameVerb(
      'get',
      'Read a quest: its manifest (goal, target, status, gate, contracts) + the full append-only log. petname required.',
      post,
    ),

    quest_status: petnameVerb(
      'status',
      'Compute the quest completion predicate (§4c): every board card tagged quest=<petname> reported with its lane ' +
        'and whether that lane is terminal (done|archived), plus an allTerminal + complete boolean. v1: complete = ' +
        'every card terminal AND not aborted; delivered-per-target integrator semantics arrive in a later packet. petname required.',
      post,
    ),

    list_quests: {
      description: 'List every quest in the project (manifest fields only), newest-updated first.',
      inputSchema: { type: 'object' as const, properties: { project: PROJECT_PROP }, required: ['project'] },
      async handle(p: Params) {
        if (!p.project) return err('project (URI) is required')
        return post({ project: p.project, op: 'list' })
      },
    },
  }
}
