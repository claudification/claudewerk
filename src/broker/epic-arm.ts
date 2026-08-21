/**
 * ARMING AN EPIC RUN -- the one path, for every caller that arms one.
 *
 * There are two callers now: the human pressing RUN (and the `epic_run
 * action=start` MCP tool, which is the same HTTP route) and a SCHEDULE whose
 * action is `epic-start`. A second arm path that forwarded the sentinel op
 * directly would produce a run that sits `armed` on disk and is invisible to the
 * sweep forever, because the bookkeeping the op does NOT do lives here:
 *
 *   - `noteArmedEpic`, without which `epicsToWatch` never sees a run that has no
 *     conversations yet -- which is every run, at exactly the moment it is armed
 *     (see epic-registry.ts for the chicken-and-egg this closes);
 *   - `forgetDeletedEpic`, because arming un-deletes -- a fresh `run.md` behind a
 *     tombstone is a live run nothing renders;
 *   - `publishActivity`, so the header badge counts it now rather than up to 45s
 *     from now;
 *   - and the "epics" scanner OPT-IN, which has to refuse at the ARM: the sweep
 *     drops an armed run in an opted-out project, so an arm that reported success
 *     would be a silent hang told at the one moment somebody could have fixed it.
 *
 * So the route calls this, the scheduler calls this, and neither owns a copy.
 */

import type { EpicOpKind, EpicResult } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import { sendEpicOp } from './epic-broker-rpc'
import { forgetArmedEpic, forgetDeletedEpic, noteArmedEpic } from './epic-registry'
import { buildSweepDeps } from './epic-sweep-loop'
import { scannerEnabledForProject } from './project-settings'

/**
 * The "epics" scanner opt-in, as a refusal or null.
 *
 * Its own function because two things ask it -- the arm below, and any caller
 * that wants to refuse BEFORE spending a sentinel round-trip -- and because the
 * wording is the whole value: it names the box and where to tick it.
 */
export function epicsScannerRefusal(project: string): string | null {
  if (scannerEnabledForProject(project, 'epics')) return null
  return (
    `the "epics" scanner is off for ${project}, so an armed run would never be swept -- ` +
    `tick it in Project Settings > Scanners first`
  )
}

/**
 * Keep the sweep's armed-epic set in step with what just happened.
 *
 * Called ONLY after a successful op: registering an epic whose sentinel refused
 * the write would leave the sweep beating on a run that does not exist.
 */
export function trackEpicOp(input: { project: string; op: EpicOpKind | string; epicId: string }): void {
  if (input.op === 'start') {
    noteArmedEpic(input.project, input.epicId)
    // ARMING UN-DELETES. A `start` writes a fresh `run.md`, so the epic has a
    // real run again -- leaving its tombstone in place would keep that new run
    // off the wall, the badge and `list` while it was genuinely running, which
    // is the invisibility the whole tail section exists to prevent.
    forgetDeletedEpic(input.project, input.epicId)
  } else if (input.op === 'pause' || input.op === 'abort') forgetArmedEpic(input.project, input.epicId)
}

export interface ArmEpicInput {
  project: string
  epicId: string
  /** The `EpicStartInput` blob, forwarded verbatim -- `cadence`, `target`,
   *  `concurrency` and the three caps. Absent means "resume as it stands", which
   *  is what `start` has always meant with no payload. */
  start?: Record<string, unknown>
}

export type ArmEpicResult =
  | { ok: true; result: EpicResult }
  /** `status` is the HTTP one the route answers with: 400 for a refusal this
   *  side made, 502 for a sentinel that would not write. */
  | { ok: false; error: string; status: 400 | 502 }

/** Arm (or resume) one epic run, with every piece of bookkeeping an arm owes. */
export async function armEpicRun(store: ConversationStore, input: ArmEpicInput): Promise<ArmEpicResult> {
  const refusal = epicsScannerRefusal(input.project)
  if (refusal) return { ok: false, error: refusal, status: 400 }

  const result = await sendEpicOp(store, input.project, {
    op: 'start',
    epicId: input.epicId,
    ...(input.start ? { start: input.start } : {}),
  })
  if (!result.ok) return { ok: false, error: result.error ?? 'epic op failed', status: 502 }

  trackEpicOp({ project: input.project, op: 'start', epicId: input.epicId })
  // Arming is one of the moments a human is definitely looking at the badge, so
  // it does not wait for the next 45s tick. `void` deliberately: the caller's
  // reply must not block on a broadcast.
  void buildSweepDeps(store).publishActivity?.()
  return { ok: true, result }
}
