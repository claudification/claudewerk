/**
 * RESOLVING A PARTIAL RECAP -- the reader's call, not the pipeline's.
 *
 * When a chunked recap comes back partial, only a human can weigh what the
 * missing conversation was worth. Re-running it costs a map call plus a full
 * reduce (on the 2026-07-28 incident: ~$2-4 to recover one conversation out of
 * 169), and sometimes the casualty is a dead-end thread nobody will miss. So we
 * offer the three real choices and record which one was made:
 *
 *   retry_failed    -- re-map the casualties, re-synthesize (costs the most,
 *                      loses nothing)
 *   synthesize_only -- give up on them, rebuild the document from banked output
 *   accept          -- keep it exactly as-is (costs nothing)
 *
 * ACCEPT DOES NOT REWRITE HISTORY. The status stays `partial` and the casualty
 * list stays on the row: accepting a recap means "I know what is missing and I
 * am fine with it", not "pretend it is complete". The only thing that changes
 * is that the recap stops asking -- an accepted partial is settled, an
 * unresolved one is still waiting on somebody.
 */

import type { RecapResolution, RecapResolutionMode } from '../../../shared/protocol'
import { describePartial } from './chunk/map-failure'
import type { PeriodRecapStore, RecapRow } from './store'

export interface AcceptDeps {
  store: Pick<PeriodRecapStore, 'get' | 'update' | 'appendLog'>
  bundle?: { updateManifest(recapId: string, patch: { error?: string }): void }
}

export interface AcceptResult {
  recapId: string
  resolution: RecapResolution
  /** Casualties the reader is knowingly signing off on. */
  accepted: number
}

/** Settle a partial recap as-is. Refuses anything that is not partial: there is
 *  nothing to accept about a clean recap, and accepting a FAILED one would hide
 *  a document that was never produced. */
export function acceptPartial(deps: AcceptDeps, recapId: string, by?: string): AcceptResult {
  const row = deps.store.get(recapId)
  if (!row) throw new Error(`recap ${recapId} not found`)
  if (row.status !== 'partial') {
    throw new Error(`recap ${recapId} is ${row.status}, not partial -- nothing to accept`)
  }
  const failures = parseFailures(row)
  const resolution: RecapResolution = {
    mode: 'accept',
    at: Date.now(),
    ...(by ? { by } : {}),
    note: failures.length > 0 ? describePartial(failures, failures.length) : 'accepted with no recorded casualties',
  }
  deps.store.update(recapId, { resolutionJson: JSON.stringify(resolution) })
  // LOG EVERYTHING: a human decision to give up on data is exactly the kind of
  // thing a future reader will want to find in the trail.
  deps.store.appendLog({
    recapId,
    timestamp: resolution.at,
    level: 'info',
    phase: 'resolve',
    message: `partial recap ACCEPTED as-is${by ? ` by ${by}` : ''} -- ${failures.length} casualty(s) signed off, nothing re-run`,
  })
  return { recapId, resolution, accepted: failures.length }
}

/** Human label for a resolution, for logs + the inform message. */
export function describeResolution(mode: RecapResolutionMode): string {
  return RESOLUTION_LABELS[mode] ?? mode
}

const RESOLUTION_LABELS: Record<RecapResolutionMode, string> = {
  retry_failed: 're-running the failed chunks, then re-synthesizing',
  synthesize_only: 'abandoning the failed chunks and re-synthesizing from what is banked',
  accept: 'accepting the recap as-is',
}

function parseFailures(row: RecapRow) {
  if (!row.failuresJson) return []
  try {
    const parsed = JSON.parse(row.failuresJson) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
