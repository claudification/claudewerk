import type {
  RecapAudience,
  RecapCreateMessage,
  RecapStatus,
  RecapTemplatesRequest,
  RecapTemplatesResult,
} from '../../shared/protocol'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, detectRole, registerHandlers, type WsRole } from '../message-router'
import { buildTemplateList } from '../recap/templates'
import { getRecapOrchestrator } from '../recap-orchestrator'
import { requireStrings } from './validate'

function recapCreate(ctx: HandlerContext, data: MessageData): void {
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const echo = requestId ? { requestId } : {}
  // Pillar B: agent-host callers may trigger recaps only when benevolent (the
  // eval harness runs as a benevolent robot). Dashboards are inherently trusted.
  // The router role gate already admitted agent-host to recap_create; this is the
  // trust gate. The reply echoes requestId so the MCP call surfaces the error
  // instead of hanging to a 30s silent timeout.
  if (detectRole(ctx.ws.data) === 'agent-host' && ctx.callerSettings?.trustLevel !== 'benevolent') {
    ctx.reply({ type: 'recap_error', error: 'Requires benevolent trust level', ...echo })
    return
  }
  const fields = requireStrings(ctx, data, ['projectUri', 'timeZone'] as const, 'recap_create')
  if (!fields) return
  const batchId = typeof data.batchId === 'string' ? data.batchId : undefined
  if (batchId) {
    ctx.log.info(
      `[recap_create] batch=${batchId} project=${fields.projectUri} period=${(data.period as { label?: string } | null)?.label ?? 'unknown'} requestId=${requestId ?? 'none'}`,
    )
  }
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({ type: 'recap_error', error: 'recap orchestrator not initialised', ...echo })
    return
  }
  const period = (data.period as RecapCreateMessage['period']) ?? null
  if (!period?.label) {
    ctx.reply({ type: 'recap_error', error: 'period.label is required', ...echo })
    return
  }
  if (fields.projectUri !== '*') ctx.requirePermission('chat:read', fields.projectUri)
  // audience: pass through whatever the caller set (the MCP tool defaults it
  // to 'agent'); undefined -> orchestrator defaults to 'human'.
  const audience: RecapAudience | undefined =
    data.audience === 'agent' || data.audience === 'human' ? data.audience : undefined
  // Pillar D: eval-harness tuning overrides. Already benevolent-gated -- the
  // whole recap_create from agent-host required benevolent trust above, and the
  // dashboard UI never sends these. Passed through verbatim; the orchestrator
  // reads each field defensively and persists the resolved recipe to args_json.
  const tuning =
    data.tuning && typeof data.tuning === 'object' ? (data.tuning as RecapCreateMessage['tuning']) : undefined
  // Pillar F: retrospect is a top-level product mode (NOT benevolent-gated, NOT
  // in tuning) -- anyone who can create a recap can ask for the retrospective.
  const retrospect = data.retrospect === true
  // customerFriendly is a top-level product mode like retrospect (NOT gated, NOT
  // in tuning): sanitize the recap's tone for sharing outside the team.
  const customerFriendly = data.customerFriendly === true
  // instructions: free-text shaping directives for the final refinement stage
  // (presentation-only; never touches extraction). Trimmed; empty -> omitted.
  const instructionsRaw = typeof data.instructions === 'string' ? data.instructions.trim() : ''
  const instructions = instructionsRaw || undefined
  // inform_on_complete: the target conversation is the CALLER's own
  // conversation, derived from the WS connection -- never passed by the agent.
  const informOnComplete = data.inform_on_complete === true
  const informConversationId = informOnComplete ? ctx.ws.data.conversationId : undefined
  if (informOnComplete && !informConversationId) {
    ctx.log.debug('[recap_create] inform_on_complete set but caller has no conversationId -- push skipped')
  }
  // Templates (PLAN phase 3): `template` selects the deliverable shape (default
  // 'project-recap', the byte-identical anchor); `options` overrides the selected
  // template's declared option defaults. Both resolved + validated orchestrator-side.
  const template = typeof data.template === 'string' ? data.template : undefined
  const options =
    data.options && typeof data.options === 'object' && !Array.isArray(data.options)
      ? (data.options as Record<string, boolean>)
      : undefined
  orchestrator
    .start({
      type: 'recap_create',
      projectUri: fields.projectUri,
      period,
      timeZone: fields.timeZone,
      signals: data.signals as RecapCreateMessage['signals'],
      force: Boolean(data.force),
      ...(audience ? { audience } : {}),
      ...(retrospect ? { retrospect: true } : {}),
      ...(customerFriendly ? { customerFriendly: true } : {}),
      ...(instructions ? { instructions } : {}),
      ...(template ? { template } : {}),
      ...(options ? { options } : {}),
      ...(tuning ? { tuning } : {}),
      ...(informConversationId ? { informConversationId } : {}),
    })
    .then(result => ctx.reply({ type: 'recap_created', recapId: result.recapId, cached: result.cached, ...echo }))
    .catch((err: unknown) => ctx.reply({ type: 'recap_error', error: describe(err), ...echo }))
}

// fallow-ignore-next-line complexity
function recapRegenerate(ctx: HandlerContext, data: MessageData): void {
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined
  const echo = requestId ? { requestId } : {}
  // Pillar C++: same trust posture as recap_create -- benevolent agent-host only
  // (the eval harness re-runs synthesis); dashboards are inherently trusted.
  if (detectRole(ctx.ws.data) === 'agent-host' && ctx.callerSettings?.trustLevel !== 'benevolent') {
    ctx.reply({ type: 'recap_error', error: 'Requires benevolent trust level', ...echo })
    return
  }
  const fields = requireStrings(ctx, data, ['recapId', 'from'] as const, 'recap_regenerate')
  if (!fields) return
  const from = fields.from
  if (from !== 'synthesize' && from !== 'render' && from !== 'html') {
    ctx.reply({ type: 'recap_error', error: `invalid from: ${from} (synthesize|render|html)`, ...echo })
    return
  }
  const mode = data.mode === 'in-place' ? 'in-place' : data.mode === 'fork' ? 'fork' : undefined
  const model = typeof data.model === 'string' ? data.model : undefined
  // instructions: forward only when the KEY is present (undefined => reuse the
  // source's; a string, incl. empty, => override). Label/sampling are simple.
  const instructions = typeof data.instructions === 'string' ? data.instructions : undefined
  const variantLabel = typeof data.variantLabel === 'string' ? data.variantLabel.trim() || undefined : undefined
  const temperature = typeof data.temperature === 'number' ? data.temperature : undefined
  const maxTokens = typeof data.maxTokens === 'number' ? data.maxTokens : undefined
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({ type: 'recap_error', error: 'recap orchestrator not initialised', ...echo })
    return
  }
  try {
    const result = orchestrator.regenerate({
      recapId: fields.recapId,
      from,
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      ...(variantLabel ? { variantLabel } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    })
    ctx.reply({
      type: 'recap_regenerated',
      recapId: result.recapId,
      sourceRecapId: result.sourceRecapId,
      mode: result.mode,
      from: result.from,
      ...echo,
    })
  } catch (err) {
    // Version-gate / missing-bundle / unreachable-stage errors surface here
    // synchronously (not a 30s silent MCP timeout) thanks to requestId echo.
    ctx.reply({ type: 'recap_error', error: describe(err), ...echo })
  }
}

function recapCancel(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['recapId'] as const, 'recap_cancel')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) return
  orchestrator.cancel(fields.recapId)
  ctx.reply({ type: 'recap_cancelled', recapId: fields.recapId })
}

function recapDismissFailed(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['recapId'] as const, 'recap_dismiss_failed')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) return
  orchestrator.dismiss(fields.recapId)
  ctx.reply({ type: 'recap_dismissed', recapId: fields.recapId })
}

function recapResume(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['recapId'] as const, 'recap_resume')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({ type: 'recap_error', error: 'recap orchestrator not initialised' })
    return
  }
  try {
    const result = orchestrator.resume(fields.recapId)
    ctx.reply({
      type: 'recap_resumed',
      recapId: result.recapId,
      resumeCount: result.resumeCount,
      reusableChunks: result.reusableChunks,
      totalChunks: result.totalChunks,
    })
  } catch (err) {
    // Guard failures (not chunked / in-flight / cap hit / no bundle) surface
    // synchronously rather than as a silent no-op.
    ctx.reply({ type: 'recap_error', error: describe(err) })
  }
}

function recapList(ctx: HandlerContext, data: MessageData): void {
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({ type: 'recap_list_result', recaps: [] })
    return
  }
  const rows = orchestrator.list({
    projectUri: typeof data.projectUri === 'string' ? data.projectUri : undefined,
    status: Array.isArray(data.status) ? (data.status as RecapStatus[]) : undefined,
    limit: typeof data.limit === 'number' ? data.limit : undefined,
  })
  ctx.reply({ type: 'recap_list_result', recaps: rows })
}

function recapGet(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['recapId'] as const, 'recap_get')
  if (!fields) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({ type: 'recap_error', error: 'recap orchestrator not initialised' })
    return
  }
  const result = orchestrator.get(fields.recapId, Boolean(data.includeLogs))
  if (!result) {
    ctx.reply({ type: 'recap_error', error: 'recap not found' })
    return
  }
  ctx.reply({ type: 'recap_get_result', recap: result.recap, ...(result.logs ? { logs: result.logs } : {}) })
}

function recapSearch(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['requestId', 'query'] as const, 'recap_search_request')
  if (!fields) return
  if (mcpTrustBarred(ctx, 'recap_search_result', fields.requestId)) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) {
    ctx.reply({
      type: 'recap_search_result',
      requestId: fields.requestId,
      ok: false,
      error: 'orchestrator not initialised',
    })
    return
  }
  const results = orchestrator.search(fields.query, {
    projectFilter: typeof data.projectFilter === 'string' ? data.projectFilter : undefined,
    limit: typeof data.limit === 'number' ? data.limit : undefined,
  })
  ctx.reply({ type: 'recap_search_result', requestId: fields.requestId, ok: true, results })
}

/** Pillar B trust gate for agent-host MCP read tools. The `recap_mcp_*` /
 *  `recap_search_request` handlers exist specifically for agent-host callers, so
 *  agent-host is in their role allowlist -- but, like recap_create/regenerate, an
 *  agent-host may only read recaps when benevolent. Replies on the matching
 *  `_result` type (forwarded to broker-rpc) so the MCP call surfaces the error
 *  instead of hanging to a silent timeout. Returns true when the caller is barred. */
function mcpTrustBarred(ctx: HandlerContext, resultType: string, requestId: string): boolean {
  if (detectRole(ctx.ws.data) === 'agent-host' && ctx.callerSettings?.trustLevel !== 'benevolent') {
    ctx.reply({ type: resultType, requestId, ok: false, error: 'Requires benevolent trust level' })
    return true
  }
  return false
}

function recapMcpGet(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['requestId', 'recapId'] as const, 'recap_mcp_get_request')
  if (!fields) return
  if (mcpTrustBarred(ctx, 'recap_mcp_get_result', fields.requestId)) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) return
  const result = orchestrator.get(fields.recapId, false)
  if (!result) {
    ctx.reply({ type: 'recap_mcp_get_result', requestId: fields.requestId, ok: false, error: 'not found' })
    return
  }
  ctx.reply({ type: 'recap_mcp_get_result', requestId: fields.requestId, ok: true, recap: result.recap })
}

function recapMcpList(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['requestId'] as const, 'recap_mcp_list_request')
  if (!fields) return
  if (mcpTrustBarred(ctx, 'recap_mcp_list_result', fields.requestId)) return
  const orchestrator = getRecapOrchestrator()
  if (!orchestrator) return
  const recaps = orchestrator.list({
    projectUri: typeof data.projectFilter === 'string' ? data.projectFilter : undefined,
    limit: typeof data.limit === 'number' ? data.limit : undefined,
  })
  ctx.reply({ type: 'recap_mcp_list_result', requestId: fields.requestId, ok: true, recaps })
}

function recapTemplates(ctx: HandlerContext, data: MessageData): void {
  const fields = requireStrings(ctx, data, ['requestId'] as const, 'recap_templates_request')
  if (!fields) return
  // NO trust gate. Templates are read-only built-in fleet metadata (deliverable
  // shapes + their option knobs), NOT project data -- unlike recap_create (spends
  // tokens) and the recap_mcp_* read tools (expose recap CONTENT), which require
  // benevolent trust for agent-host. Any role the router admitted may enumerate.
  const audience: RecapTemplatesRequest['audience'] =
    data.audience === 'agent' || data.audience === 'human' ? data.audience : undefined
  const { templates, defaultTemplateId } = buildTemplateList()
  const filtered = audience ? templates.filter(t => t.audience === audience) : templates
  ctx.reply({
    type: 'recap_templates_result',
    requestId: fields.requestId,
    ok: true,
    templates: filtered,
    defaultTemplateId,
  } satisfies RecapTemplatesResult)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Recap handlers that additionally accept benevolent agent-host callers (the eval
// harness + MCP read tools): create/regenerate (write) and the `*_request` MCP read
// variants (get/list/search). All gate trust INSIDE the handler -- the role allowlist
// only admits the connection; benevolent trust is then required for agent-host.
// recap_mcp_*_request / recap_search_request exist SPECIFICALLY for agent-host MCP
// tools, so excluding agent-host (the old DASHBOARD_ROLES registration) made every
// agent-host call hang to a silent timeout (Bug 2a).
const RECAP_AGENT_HOST_ROLES: WsRole[] = [...DASHBOARD_ROLES, 'agent-host']

export function registerRecapHandlers(): void {
  registerHandlers(
    {
      recap_create: recapCreate,
      recap_regenerate: recapRegenerate,
      recap_search_request: recapSearch,
      recap_mcp_get_request: recapMcpGet,
      recap_mcp_list_request: recapMcpList,
      recap_templates_request: recapTemplates,
    } satisfies Record<string, MessageHandler>,
    RECAP_AGENT_HOST_ROLES,
  )
  registerHandlers(
    {
      recap_cancel: recapCancel,
      recap_dismiss_failed: recapDismissFailed,
      recap_resume: recapResume,
      recap_list: recapList,
      recap_get: recapGet,
    } satisfies Record<string, MessageHandler>,
    DASHBOARD_ROLES,
  )
}
