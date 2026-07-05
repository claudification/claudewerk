/**
 * QUEST write verbs (plan-quest-engine §4e/§13): create_quest, update_quest,
 * quest_log_append, abort_quest, pause_quest. See quest.ts for the shared
 * post/err plumbing. Every verb POSTs one op-envelope; the SENTINEL is the sole
 * writer of the quest tree.
 */

import { questErr as err, PROJECT_PROP, parseJson, petnameVerb, type QuestPost } from './quest-tool-lib'
import type { McpToolContext, ToolDef } from './types'

type Params = Record<string, string>

// Flat registry of tool definitions -- long by line count, not by branching.
export function questWriteVerbs(ctx: McpToolContext, post: QuestPost): Record<string, ToolDef> {
  return {
    create_quest: {
      description:
        'Create a QUEST (petname-selected set of board cards + a manifest folder) and get its generated petname ' +
        '(e.g. floppy-panda). Writes .rclaude/project/quests/<petname>/manifest.md. goal required. target=pr|merged|' +
        'shipped (default pr). contracts = JSON array of {id, command, description?} machine-checkable acceptance ' +
        'commands (§1 -- author BEFORE work). cards = JSON array of {slug, status} board cards to tag into the quest. ' +
        'gate=pending|blessed|rejected (default pending -- nothing dispatches until blessed).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: PROJECT_PROP,
          goal: { type: 'string', description: 'The quest goal (required).' },
          target: { type: 'string', enum: ['pr', 'merged', 'shipped'], description: 'Delivery target (default pr).' },
          gate: { type: 'string', enum: ['pending', 'blessed', 'rejected'], description: 'Intake gate verdict.' },
          contracts: { type: 'string', description: 'JSON array of {id, command, description?}.' },
          cards: { type: 'string', description: 'JSON array of {slug, status} to tag into the quest.' },
          petname: { type: 'string', description: 'Force a petname (else one is generated + collision-checked).' },
        },
        required: ['project', 'goal'],
      },
      // fallow-ignore-next-line complexity
      async handle(p: Params) {
        if (!p.project) return err('project (URI) is required')
        if (!p.goal) return err('goal is required')
        const contracts = parseJson<unknown[]>(p.contracts, 'contracts')
        if (contracts && 'error' in contracts) return err(contracts.error)
        const cards = parseJson<unknown[]>(p.cards, 'cards')
        if (cards && 'error' in cards) return err(cards.error)
        return post({
          project: p.project,
          op: 'create',
          create: {
            goal: p.goal,
            target: p.target || undefined,
            gate: p.gate || undefined,
            contracts,
            cards,
            petname: p.petname || undefined,
          },
        })
      },
    },

    update_quest: {
      description:
        'Patch a quest manifest (steering). petname required. Set any of goal, target (pr|merged|shipped), gate ' +
        '(pending|blessed|rejected), status (intake|armed|running|paused|complete|aborted), contracts (JSON array). ' +
        'The append-only log is NEVER touched here -- use quest_log_append for intent/completion/plan/steering entries.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: PROJECT_PROP,
          petname: { type: 'string', description: 'The quest petname (required).' },
          goal: { type: 'string' },
          target: { type: 'string', enum: ['pr', 'merged', 'shipped'] },
          gate: { type: 'string', enum: ['pending', 'blessed', 'rejected'] },
          status: { type: 'string', enum: ['intake', 'armed', 'running', 'paused', 'complete', 'aborted'] },
          contracts: { type: 'string', description: 'JSON array of {id, command, description?}.' },
        },
        required: ['project', 'petname'],
      },
      // fallow-ignore-next-line complexity
      async handle(p: Params) {
        if (!p.project || !p.petname) return err('project + petname are required')
        const contracts = parseJson<unknown[]>(p.contracts, 'contracts')
        if (contracts && 'error' in contracts) return err(contracts.error)
        const patch: Record<string, unknown> = {}
        if (p.goal) patch.goal = p.goal
        if (p.target) patch.target = p.target
        if (p.gate) patch.gate = p.gate
        if (p.status) patch.status = p.status
        if (contracts) patch.contracts = contracts
        return post({ project: p.project, op: 'update', petname: p.petname, patch })
      },
    },

    quest_log_append: {
      description:
        'Append ONE entry to the quest APPEND-ONLY log (never rewritten -- this is why it is a separate verb). ' +
        'petname required. kind=intent|completion|plan|steering. body = the entry text. conv_id defaults to the ' +
        "calling conversation's id (the leg). intent serves the RESUMER (what was I about to do); completion is the " +
        'narrative beside machine-captured git facts.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: PROJECT_PROP,
          petname: { type: 'string', description: 'The quest petname (required).' },
          kind: { type: 'string', enum: ['intent', 'completion', 'plan', 'steering'], description: 'Entry kind.' },
          body: { type: 'string', description: 'The entry text (required).' },
          conv_id: { type: 'string', description: 'Authoring conversation id (defaults to the caller).' },
        },
        required: ['project', 'petname', 'body'],
      },
      async handle(p: Params) {
        if (!p.project || !p.petname) return err('project + petname are required')
        if (!p.body) return err('body is required')
        const convId = p.conv_id || ctx.getIdentity()?.conversationId || 'unknown'
        return post({
          project: p.project,
          op: 'log_append',
          petname: p.petname,
          logAppend: { kind: p.kind || 'intent', convId, body: p.body },
        })
      },
    },

    abort_quest: {
      description:
        'KILL SWITCH (§13): stamp the quest manifest aborted and archive every NON-terminal quest card with a ' +
        'SKIPPED-by-abort reason. petname required; reason recommended. NOTE (v1): this does NOT drain running legs -- ' +
        'orchestrator integration (terminate/park worktrees) comes with a later packet. Use pause_quest to stop ' +
        'dispatching without stamping cards.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: PROJECT_PROP,
          petname: { type: 'string', description: 'The quest petname (required).' },
          reason: { type: 'string', description: 'Why the quest was aborted.' },
        },
        required: ['project', 'petname'],
      },
      async handle(p: Params) {
        if (!p.project || !p.petname) return err('project + petname are required')
        return post({ project: p.project, op: 'abort', petname: p.petname, reason: p.reason || undefined })
      },
    },

    pause_quest: petnameVerb(
      'pause',
      'Pause a quest (§13): stamp the manifest paused so nothing new dispatches. No card stamping (unlike abort_quest) ' +
        '-- resume by setting status back with update_quest. petname required.',
      post,
    ),
  }
}
