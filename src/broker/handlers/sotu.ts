/**
 * SOTU contribution-spine wire handlers (Phase 1 `scribe_note` + Phase 3
 * `turn_digest`).
 *
 * An agent host emits two kinds of contribution:
 *  - `scribe_note` -- a copy of an inline `<callout>` (declared intent, high weight).
 *  - `turn_digest` -- the always-on per-turn baseline floor (compact intent +
 *    files touched + result, NOT raw messages).
 * Both append to the project's queue via the single `recordContribution`
 * chokepoint, bump the weighted pending counter, and broadcast `sotu_contribution`
 * so the live soft-lock map updates. NO LLM -- the free floor. The distill engine
 * (Phase 4) drains it.
 *
 * Trust: agent-host callers must be benevolent (recap Pillar B gate). The reply
 * echoes `requestId` so a belt-and-suspenders MCP caller surfaces the error
 * instead of hanging to a silent timeout.
 *
 * Boundary: the broker receives ALREADY-STRUCTURED messages; it never parses CC
 * output (the `<callout>` parse + the turn-digest distillation happen at the
 * agent host, Phase 3).
 */

import type { ScribeNote, SotuContribution } from '../../shared/protocol'
import type { HandlerContext, MessageData } from '../handler-context'
import { AGENT_HOST_ONLY, detectRole, registerHandlers } from '../message-router'
import { recordContribution } from '../sotu/contribute'
import { projectSlug } from '../sotu/paths'
import type { CalloutContrib, Contribution, TurnDigestContrib } from '../sotu/types'

const VALID_NOTE_TYPES = new Set<ScribeNote['noteType']>(['insight', 'lock', 'blocked', 'focus', 'dead-end'])

type Echo = { requestId?: string }

/** The resolved source for a contribution: conv + project come from the caller's
 *  OWN connection (never the wire body) so a host can't mis-route another
 *  project's queue. */
interface Source {
  convId: string
  project: string
}

/** Pillar B trust gate: an agent host may contribute only when benevolent. The
 *  router already admitted the agent-host role; this is the trust check. Returns
 *  an error string when rejected, else null. */
function trustError(ctx: HandlerContext): string | null {
  if (detectRole(ctx.ws.data) === 'agent-host' && ctx.callerSettings?.trustLevel !== 'benevolent') {
    return 'Requires benevolent trust level'
  }
  return null
}

/** Resolve the source conv + project from the caller's OWN connection (the wire
 *  body's convId is honored only as a hint, but the project is always derived
 *  from the broker's view of that conv so a host can't spoof another queue). */
function resolveSource(ctx: HandlerContext, data: MessageData): Source | null {
  const convId = (typeof data.convId === 'string' ? data.convId : undefined) ?? ctx.ws.data.conversationId
  if (!convId) return null
  const project = ctx.conversations.getConversation(convId)?.project ?? ctx.caller?.project
  return project ? { convId, project } : null
}

/** Record a contribution + broadcast the refreshed live map + ack the caller.
 *  Shared by both handlers so the queue append / pending bump / broadcast can
 *  never drift between the two contribution kinds. */
function commit(
  ctx: HandlerContext,
  resultType: string,
  src: Source,
  contrib: Contribution,
  echo: Echo,
  logLine: string,
): void {
  const { pendingContribs } = recordContribution(projectSlug(src.project), contrib)
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
}

/** Build the callout queue contribution from a validated note. Optional fields
 *  (ttl, claim/stake target) are spread in only when present. */
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

function scribeNote(ctx: HandlerContext, data: MessageData): void {
  const echo: Echo = typeof data.requestId === 'string' ? { requestId: data.requestId } : {}
  const denied = trustError(ctx)
  if (denied) {
    ctx.reply({ type: 'scribe_note_result', ok: false, error: denied, ...echo })
    return
  }
  const noteType = data.noteType as ScribeNote['noteType'] | undefined
  const payload = typeof data.payload === 'string' ? data.payload : undefined
  if (!noteType || !VALID_NOTE_TYPES.has(noteType) || !payload) {
    ctx.reply({ type: 'scribe_note_result', ok: false, error: 'scribe_note requires noteType + payload', ...echo })
    return
  }
  const src = resolveSource(ctx, data)
  if (!src) {
    ctx.reply({ type: 'scribe_note_result', ok: false, error: 'no resolvable conversation/project', ...echo })
    return
  }
  const contrib = buildCallout(data, src.convId, noteType, payload)
  commit(
    ctx,
    'scribe_note_result',
    src,
    contrib,
    echo,
    `scribe_note conv=${src.convId.slice(0, 8)} type=${contrib.type}`,
  )
}

/** Build the turn-digest queue contribution. Optional fields are spread in only
 *  when present so an empty digest never lands. */
function buildTurnDigest(data: MessageData, convId: string): TurnDigestContrib {
  const stringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  const touching = stringArray(data.touching)
  return {
    kind: 'turn_digest',
    convId,
    ts: typeof data.ts === 'number' ? data.ts : Date.now(),
    ...(typeof data.intent === 'string' ? { intent: data.intent } : {}),
    ...(touching && touching.length ? { touching } : {}),
    ...(typeof data.result === 'string' ? { result: data.result } : {}),
    ...(typeof data.blockedOn === 'string' ? { blockedOn: data.blockedOn } : {}),
  }
}

function turnDigest(ctx: HandlerContext, data: MessageData): void {
  const echo: Echo = typeof data.requestId === 'string' ? { requestId: data.requestId } : {}
  const denied = trustError(ctx)
  if (denied) {
    ctx.reply({ type: 'turn_digest_result', ok: false, error: denied, ...echo })
    return
  }
  const src = resolveSource(ctx, data)
  if (!src) {
    ctx.reply({ type: 'turn_digest_result', ok: false, error: 'no resolvable conversation/project', ...echo })
    return
  }
  const contrib = buildTurnDigest(data, src.convId)
  const touchCount = contrib.touching?.length ?? 0
  commit(
    ctx,
    'turn_digest_result',
    src,
    contrib,
    echo,
    `turn_digest conv=${src.convId.slice(0, 8)} touched=${touchCount}`,
  )
}

export function registerSotuHandlers(): void {
  registerHandlers({ scribe_note: scribeNote, turn_digest: turnDigest }, AGENT_HOST_ONLY)
}
