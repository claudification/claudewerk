/**
 * SOTU read-surface wire handlers (Phase 5) -- the agent-facing MCP RPCs:
 *   - `get_state_of_union_request` -- read the SOTU for a project. LAZY-REGEN-IF-
 *     STALE (awaits `maybeDistillOnRead`, the "wither on return" path) then serves
 *     the fused view: chronicle narrative + the free floor (active claims/stakes
 *     with CONTENDED flags + git alerts).
 *   - `sotu_contribute_request` -- the belt-and-suspenders write tool. Routes
 *     through the SAME `recordContribution` chokepoint (via `commit`) as the inline
 *     `<callout>` -- not a second write path.
 *
 * Both are benevolent-gated for agent-host callers (recap Pillar B) and echo
 * `requestId` so a belt-and-suspenders MCP caller surfaces an error instead of
 * hanging to a silent timeout. The reply is sent AFTER the async regen resolves.
 */

import type { CalloutType, GetStateOfUnionResult, SotuContributeResult } from '../../shared/protocol'
import type { HandlerContext, MessageData } from '../handler-context'
import { AGENT_HOST_ONLY, registerHandlers } from '../message-router'
import { defaultResolveSotuConfig } from '../sotu/config'
import { maybeDistillOnRead } from '../sotu/engine'
import { projectSlug } from '../sotu/paths'
import { buildSotuView } from '../sotu/view'
import {
  buildCallout,
  commit,
  echoOf,
  resolveReadProject,
  resolveSource,
  trustError,
  VALID_NOTE_TYPES,
} from './sotu-shared'

async function serveView(ctx: HandlerContext, project: string, echo: { requestId?: string }): Promise<void> {
  // Lazy-regen-if-stale: a no-op (fast) when fresh + nothing pending, or for a
  // floor-only (disabled) project; a real Opus reconcile only on staleness. The
  // free floor is served regardless of whether the regen spent anything.
  try {
    await maybeDistillOnRead(project)
  } catch (err) {
    ctx.log.error(`[sotu] get_state_of_union regen failed project=${project}: ${(err as Error)?.message ?? err}`)
  }
  const enabled = defaultResolveSotuConfig(project).enabled
  const view = buildSotuView({ slug: projectSlug(project), project, enabled, now: Date.now() })
  ctx.reply({
    type: 'get_state_of_union_result',
    requestId: echo.requestId ?? '',
    ok: true,
    view,
  } satisfies GetStateOfUnionResult)
}

function getStateOfUnion(ctx: HandlerContext, data: MessageData): void {
  const echo = echoOf(data)
  const fail = (error: string): void => {
    ctx.reply({
      type: 'get_state_of_union_result',
      requestId: echo.requestId ?? '',
      ok: false,
      error,
    } satisfies GetStateOfUnionResult)
  }
  const denied = trustError(ctx)
  if (denied) {
    fail(denied)
    return
  }
  const project = resolveReadProject(ctx, data)
  if (!project) {
    fail('no resolvable project')
    return
  }
  void serveView(ctx, project, echo)
}

function sotuContribute(ctx: HandlerContext, data: MessageData): void {
  const echo = echoOf(data)
  const fail = (error: string): void => {
    ctx.reply({
      type: 'sotu_contribute_result',
      requestId: echo.requestId ?? '',
      ok: false,
      error,
    } satisfies SotuContributeResult)
  }
  const denied = trustError(ctx)
  if (denied) {
    fail(denied)
    return
  }
  const noteType = data.noteType as CalloutType | undefined
  const payload = typeof data.payload === 'string' ? data.payload : undefined
  if (!noteType || !VALID_NOTE_TYPES.has(noteType) || !payload) {
    fail('sotu_contribute requires noteType + payload')
    return
  }
  const src = resolveSource(ctx, data)
  if (!src) {
    fail('no resolvable conversation/project')
    return
  }
  const contrib = buildCallout(data, src.convId, noteType, payload)
  commit(
    ctx,
    'sotu_contribute_result',
    src,
    contrib,
    echo,
    `sotu_contribute conv=${src.convId.slice(0, 8)} type=${noteType}`,
  )
}

export function registerSotuMcpHandlers(): void {
  registerHandlers(
    { get_state_of_union_request: getStateOfUnion, sotu_contribute_request: sotuContribute },
    AGENT_HOST_ONLY,
  )
}
