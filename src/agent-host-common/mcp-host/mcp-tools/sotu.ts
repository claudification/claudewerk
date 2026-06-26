/**
 * SOTU (State of the Union) MCP tools.
 *
 *   - get_state_of_union -- read the project's live briefing: the distilled
 *     narrative + active claims/stakes (with CONTENDED flags) + git alerts. The
 *     broker lazy-regenerates if the chronicle is stale ("wither on return").
 *   - sotu_contribute     -- belt-and-suspenders write: emit a declared-intent
 *     contribution (insight/lock/blocked/focus/dead-end, optional claim/stake
 *     target) without the inline `<callout>`. Routes through the same chokepoint.
 *
 * Both are pass-throughs: the tool mints an MCP-side requestId via brokerRpc and
 * waits for the matching broker reply. Permission gating happens server-side (the
 * broker resolves the agent host's project + benevolent trust). "@self" in
 * projectUri resolves to the agent host's conversation project.
 */

import { cwdToProjectUri } from '../../../shared/project-uri'
import type { ScribeNoteTarget, SotuConfigView, SotuDistillEval, SotuView } from '../../../shared/protocol'
import { brokerRpc, hasBrokerRpcSender } from './lib/broker-rpc'
import { errResult as err, jsonResult, notConnected } from './lib/results'
import type { McpToolContext, ToolDef, ToolResult } from './types'

const VALID_NOTE_TYPES = ['insight', 'lock', 'blocked', 'focus', 'dead-end'] as const

/** "@self" -> the caller's conversation project; any other string passes through. */
function resolveProjectUri(ctx: McpToolContext, raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  if (trimmed === '@self') {
    const identity = ctx.getIdentity()
    return identity ? cwdToProjectUri(identity.cwd) : undefined
  }
  return trimmed
}

/** Validate + normalize the `sotu_contribute` args into the RPC payload, or return
 *  an `error` string. Kept off the tool's `handle` so the handle stays flat. Flat
 *  guard clauses -- the CRAP flag is the estimated-zero-coverage artifact (the fn
 *  IS exercised by sotu.test.ts), same class recap.ts suppresses on formatSummary. */
// fallow-ignore-next-line complexity
function parseContributeArgs(params: Record<string, unknown>): { error: string } | { body: Record<string, unknown> } {
  const noteType = String(params.noteType || '').trim()
  const payload = typeof params.payload === 'string' ? params.payload : ''
  if (!(VALID_NOTE_TYPES as readonly string[]).includes(noteType)) {
    return { error: `noteType must be one of: ${VALID_NOTE_TYPES.join(', ')}` }
  }
  if (!payload.trim()) return { error: 'payload is required' }
  const target = params.target && typeof params.target === 'object' ? (params.target as ScribeNoteTarget) : undefined
  const ttlMs = typeof params.ttlMs === 'number' ? params.ttlMs : undefined
  return { body: { noteType, payload, ...(target ? { target } : {}), ...(ttlMs ? { ttlMs } : {}) } }
}

/** Run a broker RPC and map the reply to a ToolResult: `pick` returns the success
 *  payload (-> jsonResult) or `undefined` (-> the reply's error). Centralizes the
 *  try/catch + error-shape so each tool's `handle` stays flat. */
async function rpcResult<T extends { error?: string }>(
  type: string,
  payload: Record<string, unknown>,
  pick: (reply: T) => unknown,
  timeoutMs?: number,
): Promise<ToolResult> {
  try {
    const reply = await brokerRpc<T>(type, payload, timeoutMs ? { timeoutMs } : {})
    const ok = pick(reply)
    return ok === undefined ? err(reply.error || `${type} failed`) : jsonResult(ok)
  } catch (caught) {
    return err(caught instanceof Error ? caught.message : String(caught))
  }
}

function getStateOfUnionTool(ctx: McpToolContext): ToolDef {
  return {
    description:
      'Read the project State of the Union -- the live "where are we / who is touching what" briefing. ' +
      'Returns the distilled narrative (NOW / JUST DONE), the ACTIVE claims & stakes other conversations ' +
      'hold (with CONTENDED flags where two convs target the same file/concept -- coordinate before editing ' +
      'there), and git alerts (at-risk / unpushed / stalled). Call this when you join a project or before ' +
      'editing shared files. The broker regenerates the narrative if it has gone stale.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectUri: {
          type: 'string',
          description: 'Optional project URI. "@self" (or omitted) -> the caller conversation project.',
        },
      },
      required: [],
    },
    async handle(params) {
      if (!hasBrokerRpcSender()) return notConnected()
      const projectUri = resolveProjectUri(ctx, typeof params.projectUri === 'string' ? params.projectUri : undefined)
      // A stale chronicle triggers a server-side reconcile (Opus) before the reply
      // -- allow more than the default 15s RPC window for that fold.
      return rpcResult<{ view?: SotuView; error?: string }>(
        'get_state_of_union_request',
        projectUri ? { projectUri } : {},
        reply => reply.view,
        60_000,
      )
    },
  }
}

function sotuContributeTool(_ctx: McpToolContext): ToolDef {
  return {
    description:
      'Contribute a declared-intent signal to the project State of the Union (belt-and-suspenders alternative ' +
      'to the inline <callout>). noteType: insight | lock | blocked | focus | dead-end. For a soft claim on a ' +
      'file pass target {kind:"claim", path}; for a soft stake on a concept pass target {kind:"stake", concept, ' +
      'tag?}. Advisory only -- never a hard lock. Fire-and-forget; the scribe folds it into the narrative.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        noteType: { type: 'string', enum: [...VALID_NOTE_TYPES], description: 'The kind of signal.' },
        payload: { type: 'string', description: 'The note body (what you are flagging).' },
        target: {
          type: 'object',
          description: 'Optional claim (file/path) or stake (concept) for soft coordination.',
        },
        ttlMs: { type: 'number', description: 'Optional time-to-live in ms (the live map drops it after).' },
      },
      required: ['noteType', 'payload'],
    },
    async handle(params) {
      if (!hasBrokerRpcSender()) return notConnected()
      const parsed = parseContributeArgs(params)
      if ('error' in parsed) return err(parsed.error)
      return rpcResult<{ ok?: boolean; pendingContribs?: number; error?: string }>(
        'sotu_contribute_request',
        parsed.body,
        reply => (reply.ok ? { ok: true, pendingContribs: reply.pendingContribs ?? 0 } : undefined),
      )
    },
  }
}

function sotuConfigureTool(ctx: McpToolContext): ToolDef {
  return {
    description:
      'Read AND optionally tune a project State of the Union config (Phase 7, benevolent-gated). With no ' +
      'mutating field it just reads the resolved config. Pass enabled to flip the opt-in; stakes ' +
      '(main-income|client|side|experiment) to set the affordability tier that DEFAULTS the budget; ' +
      'budgetDailyUsd/budgetMonthlyUsd (number, or null to clear) to cap paid distills; params {scribeModel, ' +
      'reconcileModel, reconcileBurst, minIntervalMs, burstThreshold, quietSettleMs, staleOnReadMs, deadCutoffMs} ' +
      '(a field = null clears it) to tune the distill engine. Returns the resolved config after the write.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectUri: { type: 'string', description: '"@self" (or omitted) -> the caller conversation project.' },
        enabled: { type: 'boolean', description: 'Opt-in flag: false = free floor only, no paid distill.' },
        stakes: {
          type: 'string',
          enum: ['main-income', 'client', 'side', 'experiment'],
          description: 'Affordability tier -- defaults the budget; does NOT auto-enable.',
        },
        budgetDailyUsd: { type: ['number', 'null'], description: 'Daily USD cap (null clears).' },
        budgetMonthlyUsd: { type: ['number', 'null'], description: 'Monthly USD cap (null clears).' },
        params: { type: 'object', description: 'Distill tuning overrides (models / cutoffs / trigger constants).' },
      },
      required: [],
    },
    async handle(params) {
      if (!hasBrokerRpcSender()) return notConnected()
      const projectUri = resolveProjectUri(ctx, typeof params.projectUri === 'string' ? params.projectUri : undefined)
      const { projectUri: _drop, ...rest } = params
      return rpcResult<{ config?: SotuConfigView; error?: string }>(
        'sotu_configure_request',
        { ...rest, ...(projectUri ? { projectUri } : {}) },
        reply => reply.config,
      )
    },
  }
}

function sotuEvalTool(ctx: McpToolContext): ToolDef {
  return {
    description:
      'List a project recent SOTU distill evals (Phase 7, benevolent-gated) -- each carries the self-describing ' +
      'RECIPE (resolved models / cutoffs / trigger constants used), the COST it burned, and the GROUNDING score ' +
      '(precision / coverage / unknownCited -- the bard-lying detector). Use this to QC distill quality vs cost ' +
      'across tuning variants without re-running anything. Newest first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        projectUri: { type: 'string', description: '"@self" (or omitted) -> the caller conversation project.' },
        limit: { type: 'number', description: 'Max evals to return, newest first (default 20, max 100).' },
      },
      required: [],
    },
    async handle(params) {
      if (!hasBrokerRpcSender()) return notConnected()
      const projectUri = resolveProjectUri(ctx, typeof params.projectUri === 'string' ? params.projectUri : undefined)
      const limit = typeof params.limit === 'number' ? params.limit : undefined
      return rpcResult<{ evals?: SotuDistillEval[]; error?: string }>(
        'sotu_eval_request',
        { ...(projectUri ? { projectUri } : {}), ...(limit ? { limit } : {}) },
        reply => reply.evals,
      )
    },
  }
}

export function registerSotuTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    get_state_of_union: getStateOfUnionTool(ctx),
    sotu_contribute: sotuContributeTool(ctx),
    sotu_configure: sotuConfigureTool(ctx),
    sotu_eval: sotuEvalTool(ctx),
  }
}
