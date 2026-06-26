/**
 * Shared building blocks for the SOTU wire handlers -- the trust gate, the source
 * resolver, the callout builder, and the single commit chokepoint. Factored out so
 * the contribution-spine handlers (`scribe_note` / `turn_digest`, sotu.ts) AND the
 * belt-and-suspenders MCP write (`sotu_contribute`, sotu-mcp.ts) share ONE write
 * path -- the queue append / pending bump / broadcast can never drift apart.
 *
 * Boundary: the broker receives ALREADY-STRUCTURED messages; the source conv +
 * project come from the caller's OWN connection (never the wire body) so a host
 * can't mis-route another project's queue.
 */

import type { CalloutType, ScribeNoteTarget, SotuContribution } from '../../shared/protocol'
import type { HandlerContext, MessageData } from '../handler-context'
import { detectRole } from '../message-router'
import { recordContribution } from '../sotu/contribute'
import { projectSlug } from '../sotu/paths'
import type { CalloutContrib, Contribution } from '../sotu/types'

export const VALID_NOTE_TYPES = new Set<CalloutType>(['insight', 'lock', 'blocked', 'focus', 'dead-end'])

export type Echo = { requestId?: string }

/** The resolved source: conv + project from the caller's OWN connection. */
export interface Source {
  convId: string
  project: string
}

/** Pillar B trust gate: an agent host may contribute/read only when benevolent.
 *  Returns an error string when rejected, else null. */
export function trustError(ctx: HandlerContext): string | null {
  if (detectRole(ctx.ws.data) === 'agent-host' && ctx.callerSettings?.trustLevel !== 'benevolent') {
    return 'Requires benevolent trust level'
  }
  return null
}

/** The RPC echo `{requestId}` when present, so a belt-and-suspenders MCP caller
 *  matches the reply instead of hanging to a silent timeout. */
export function echoOf(data: MessageData): Echo {
  return typeof data.requestId === 'string' ? { requestId: data.requestId } : {}
}

/** The project a read/config RPC targets: an explicit `projectUri` when given, else
 *  the caller's OWN conversation project (resolved from the broker's view, never
 *  spoofable). Shared by `get_state_of_union`, `sotu_configure`, and `sotu_eval`. */
export function resolveReadProject(ctx: HandlerContext, data: MessageData): string | null {
  const explicit = typeof data.projectUri === 'string' ? data.projectUri.trim() : ''
  if (explicit) return explicit
  return resolveSource(ctx, data)?.project ?? null
}

/** Resolve the source conv + project from the caller's OWN connection. The wire
 *  body's convId is honored only as a hint; the project is always derived from the
 *  broker's view of that conv so a host can't spoof another queue. */
export function resolveSource(ctx: HandlerContext, data: MessageData): Source | null {
  const convId = (typeof data.convId === 'string' ? data.convId : undefined) ?? ctx.ws.data.conversationId
  if (!convId) return null
  const project = ctx.conversations.getConversation(convId)?.project ?? ctx.caller?.project
  return project ? { convId, project } : null
}

/** Build a callout queue contribution. Optional fields (ttl, claim/stake target)
 *  are spread in only when present. */
export function buildCallout(
  data: MessageData,
  convId: string,
  noteType: CalloutType,
  payload: string,
): CalloutContrib {
  return {
    kind: 'callout',
    convId,
    ts: typeof data.ts === 'number' ? data.ts : Date.now(),
    type: noteType,
    payload,
    weight: data.weight === 'baseline' ? 'baseline' : 'high',
    ...(typeof data.ttlMs === 'number' ? { ttlMs: data.ttlMs } : {}),
    ...(data.target && typeof data.target === 'object' ? { target: data.target as ScribeNoteTarget } : {}),
  }
}

/** Record a contribution + broadcast the refreshed live map + ack the caller. The
 *  ONE write chokepoint shared by every contribution source. Returns the new
 *  weighted pending count (so a caller can echo it in its result). */
export function commit(
  ctx: HandlerContext,
  resultType: string,
  src: Source,
  contrib: Contribution,
  echo: Echo,
  logLine: string,
): number {
  const { pendingContribs } = recordContribution(projectSlug(src.project), contrib, src.project)
  ctx.broadcastScoped(
    {
      type: 'sotu_contribution',
      project: src.project,
      pendingContribs,
      latest: { convId: src.convId, kind: contrib.kind, ts: contrib.ts },
    } satisfies SotuContribution,
    src.project,
  )
  ctx.log.info(`[sotu] ${logLine} pending=${pendingContribs}`)
  ctx.reply({ type: resultType, ok: true, pendingContribs, ...echo })
  return pendingContribs
}
