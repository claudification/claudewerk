/**
 * Epic substrate relay: dashboard / agent-leg <-> sentinel.
 *
 * Thin by design -- the round trip lives in `project-op-relay.ts`, so all this
 * file owns is what is genuinely epic-specific: which ops write, how a request
 * becomes an `EpicOp`, and which beat a successful write fans.
 *
 * §14 equivalent: the broker holds NO epic state. A run is fully re-derivable
 * from the board plus `.rclaude/project/epics/`, which is what lets an epic
 * survive a broker restart mid-run.
 */

import type { EpicEvent, EpicOp, EpicOpKind, EpicRequest, EpicResult } from '../../shared/protocol'
import { CONTROL_PANEL_ONLY, registerHandlers, SENTINEL_ONLY } from '../message-router'
import { buildRelayHandler, relayResultHandler } from './project-op-relay'

/** `lease` writes the epic card; `get` is the only pure read. */
const WRITE_OPS = new Set<EpicOpKind>(['start', 'patch', 'log_append', 'lease', 'release', 'pause', 'abort'])

/** Which write ops fan a beat, and under what name (STRATEGY MAP). `patch` is
 *  absent deliberately: the werk-master patches its digest several times a beat,
 *  and a broadcast per digest edit is noise, not information. */
const EVENT_BY_OP: Partial<Record<EpicOpKind, EpicEvent['event']>> = {
  start: 'started',
  lease: 'generation',
  release: 'released',
  log_append: 'logged',
  pause: 'paused',
  abort: 'aborted',
}

/** The one human-readable line an andon row can render without a re-fetch. A
 *  strategy map, not a chain -- one entry per op that has something specific to
 *  say, and a run-status fallback for the ops that do not. */
type DetailFn = (d: EpicRequest, result: EpicResult) => string

const DETAIL_BY_OP: Partial<Record<EpicOpKind, DetailFn>> = {
  lease: (_d, r) =>
    r.lease?.granted
      ? `werk-master gen ${r.lease.gen} took the epic`
      : `wake refused: ${r.lease?.reason ?? 'lease held'}`,
  abort: d => `run aborted: ${d.reason || 'no reason given'}`,
  log_append: d => {
    const card = d.logAppend?.cardId
    return `${d.logAppend?.kind ?? 'entry'}${card ? ` (${card})` : ''}`
  },
}

function detailFor(d: EpicRequest, result: EpicResult): string | undefined {
  const specific = DETAIL_BY_OP[d.op]
  if (specific) return specific(d, result)
  return result.run ? `run ${result.run.status} at gen ${result.run.gen}` : undefined
}

/**
 * A REFUSED lease is a successful op with a false verdict, and it must NOT fan a
 * `generation` beat -- two settles in one sweep is the normal case, and a beat
 * per loser would make the panel show generations that never happened.
 */
function beatFor(d: EpicRequest, result: EpicResult): EpicEvent | null {
  const event = result.ok ? EVENT_BY_OP[d.op] : undefined
  if (!event || !d.epicId) return null
  if (d.op === 'lease' && !result.lease?.granted) return null
  return {
    type: 'epic_event',
    project: d.project,
    event,
    epicId: d.epicId,
    ...(result.run ? { gen: result.run.gen, status: result.run.status } : {}),
    ...(detailFor(d, result) ? { detail: detailFor(d, result) } : {}),
  }
}

const epicRequest = buildRelayHandler<EpicRequest, EpicResult>({
  opType: 'epic_op',
  resultType: 'epic_result',
  valid: d => Boolean(d.op && d.epicId),
  isWrite: d => WRITE_OPS.has(d.op),
  errorEcho: d => ({ op: d.op }),
  beatFor,
  toOp: (d, projectRoot): Omit<EpicOp, 'type'> => ({
    requestId: d.requestId,
    projectRoot,
    op: d.op,
    epicId: d.epicId,
    start: d.start,
    patch: d.patch,
    logAppend: d.logAppend,
    lease: d.lease,
    baton: d.baton,
    reason: d.reason,
  }),
})

/** Exposed for tests: the two pieces that encode policy rather than plumbing. */
export const __testing = { beatFor, WRITE_OPS }

export function registerEpicHandlers(): void {
  // Reading/writing the epic tree exposes the project's on-disk files --
  // restricted to the authenticated control panel + benevolent agents. Share-link
  // guests are rejected by the router (CONTROL_PANEL_ONLY excludes 'share').
  registerHandlers({ epic_request: epicRequest }, CONTROL_PANEL_ONLY)
  registerHandlers({ epic_result: relayResultHandler }, SENTINEL_ONLY)
}
