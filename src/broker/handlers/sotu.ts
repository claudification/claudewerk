/**
 * SOTU `scribe_note` handler -- the contribution-spine wire seam (Phase 1).
 *
 * An agent host emits `scribe_note` (a copy of an inline `<callout>`); the broker
 * appends it to the project's queue, bumps the weighted pending counter, and
 * broadcasts `sotu_contribution` to authorized dashboards so the live soft-lock map
 * updates. NO LLM -- this is the free floor. The distill engine (Phase 4) drains it.
 *
 * Trust: agent-host callers must be benevolent (recap Pillar B gate) -- the same
 * posture as recap_create. The reply echoes `requestId` so a belt-and-suspenders
 * MCP caller surfaces the error instead of hanging to a silent timeout.
 *
 * Boundary: the broker receives an ALREADY-STRUCTURED note; it never parses CC
 * output (the `<callout>` parse happens at the agent host, Phase 3).
 */

import type { ScribeNote, SotuContribution } from '../../shared/protocol'
import type { HandlerContext, MessageData } from '../handler-context'
import { AGENT_HOST_ONLY, detectRole, registerHandlers } from '../message-router'
import { recordContribution } from '../sotu/contribute'
import { projectSlug } from '../sotu/paths'
import type { CalloutContrib } from '../sotu/types'

const VALID_NOTE_TYPES = new Set<ScribeNote['noteType']>(['insight', 'lock', 'blocked', 'focus', 'dead-end'])

type Echo = { requestId?: string }

/** Parsed + validated scribe_note, ready to record. convId + project are resolved
 *  from the caller's OWN connection (never the wire body) so a host can't mis-route
 *  another project's queue. Returns an error string on any rejection. */
interface Accepted {
  convId: string
  project: string
  contrib: CalloutContrib
}

/** Build the queue contribution from a validated note. Optional fields (ttl,
 *  claim/stake target) are spread in only when present. */
function buildCallout(
  data: MessageData,
  convId: string,
  noteType: ScribeNote['noteType'],
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
    ...(data.target && typeof data.target === 'object' ? { target: data.target as CalloutContrib['target'] } : {}),
  }
}

/** Resolve the source conv + project from the caller's OWN connection (never the
 *  wire body's project, which a host could spoof to mis-route another queue). */
function resolveSource(ctx: HandlerContext, data: MessageData): { convId: string; project: string } | null {
  const convId = (typeof data.convId === 'string' ? data.convId : undefined) ?? ctx.ws.data.conversationId
  if (!convId) return null
  const project = ctx.conversations.getConversation(convId)?.project ?? ctx.caller?.project
  return project ? { convId, project } : null
}

function acceptScribeNote(ctx: HandlerContext, data: MessageData): Accepted | { error: string } {
  const noteType = data.noteType as ScribeNote['noteType'] | undefined
  const payload = typeof data.payload === 'string' ? data.payload : undefined
  if (!noteType || !VALID_NOTE_TYPES.has(noteType) || !payload) {
    return { error: 'scribe_note requires noteType + payload' }
  }
  const src = resolveSource(ctx, data)
  if (!src) return { error: 'no resolvable conversation/project' }
  return { ...src, contrib: buildCallout(data, src.convId, noteType, payload) }
}

function scribeNote(ctx: HandlerContext, data: MessageData): void {
  const echo: Echo = typeof data.requestId === 'string' ? { requestId: data.requestId } : {}
  // Pillar B trust gate: an agent host may contribute only when benevolent. The
  // router already admitted the agent-host role; this is the trust check.
  if (detectRole(ctx.ws.data) === 'agent-host' && ctx.callerSettings?.trustLevel !== 'benevolent') {
    ctx.reply({ type: 'scribe_note_result', ok: false, error: 'Requires benevolent trust level', ...echo })
    return
  }
  const accepted = acceptScribeNote(ctx, data)
  if ('error' in accepted) {
    ctx.reply({ type: 'scribe_note_result', ok: false, error: accepted.error, ...echo })
    return
  }
  const { convId, project, contrib } = accepted
  const { pendingContribs } = recordContribution(projectSlug(project), contrib)
  ctx.broadcastScoped(
    {
      type: 'sotu_contribution',
      project,
      pendingContribs,
      latest: { convId, kind: 'callout', ts: contrib.ts },
    } satisfies SotuContribution,
    project,
  )
  ctx.log.info(`[sotu] scribe_note conv=${convId.slice(0, 8)} type=${contrib.type} pending=${pendingContribs}`)
  ctx.reply({ type: 'scribe_note_result', ok: true, pendingContribs, ...echo })
}

export function registerSotuHandlers(): void {
  registerHandlers({ scribe_note: scribeNote }, AGENT_HOST_ONLY)
}
