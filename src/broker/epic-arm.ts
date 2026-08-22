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

import { EPIC_CAP_FIELDS, unenforceableCapLine } from '../shared/epic-run-caps'
import type { EpicOpKind, EpicResult, EpicRunSnapshot } from '../shared/protocol'
import type { ConversationStore } from './conversation-store'
import { appendBaton, sendEpicOp } from './epic-broker-rpc'
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
 * THE SENTINEL CANNOT CARRY THIS RUN'S CEILINGS -- as a refusal, or null.
 *
 * THE REPLY IS THE CAPABILITY PROBE, and that is the whole design. `start` sends
 * the three ceilings, the sentinel writes them and echoes the run back; if the
 * echo does not carry them, the bundle that owns `run.md` predates them and this
 * run would dispatch with no enforceable budget at all. No new op, no version
 * handshake to keep in step, and it goes on working for whatever the next lost
 * field turns out to be -- the check is a property of the DATA.
 *
 * IT REPLACES A `grep`. Until this existed, `docs/epic-mode.md` told a human to
 * run `grep -c maxUsd packages/sentinel/bin/sentinel` before trusting a ceiling.
 * A safety mechanism whose failure detector is somebody remembering to grep a
 * 532 KB binary is not a safety mechanism.
 *
 * A MISSING RUN REFUSES TOO. A successful `start` that answered with no run at
 * all is a sentinel this broker cannot reason about either, and arming into that
 * is the same bet with less evidence.
 *
 * Its own exported function for the reason `epicsScannerRefusal` is: the WORDING
 * is most of the value, and a pure function is the only way to pin it without a
 * sentinel in the loop.
 */
export function capCapabilityRefusal(run: EpicRunSnapshot | null | undefined): string | null {
  const lost = run ? unenforceableCapLine(run) : `${EPIC_CAP_FIELDS.join(', ')} (the reply carried no run at all)`
  if (!lost) return null
  return (
    `REFUSING TO ARM: this run's ceilings cannot be enforced -- ${lost}. The sentinel that owns run.md is ` +
    'answering without the cap fields, so its bundle predates them and a run armed against it would spend ' +
    'without a budget. Run `bun run build:packages`, restart the sentinel, then arm again. ' +
    'A cap that cannot be enforced is an ERROR, never an absence.'
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

  const uncappable = capCapabilityRefusal(result.run)
  if (uncappable) return await unarm(store, input, uncappable)

  trackEpicOp({ project: input.project, op: 'start', epicId: input.epicId })
  // Arming is one of the moments a human is definitely looking at the badge, so
  // it does not wait for the next 45s tick. `void` deliberately: the caller's
  // reply must not block on a broadcast.
  void buildSweepDeps(store).publishActivity?.()
  return { ok: true, result }
}

/**
 * PUT BACK THE RUN THE SENTINEL HAS ALREADY WRITTEN, then refuse.
 *
 * The refusal is decided from the `start` REPLY, so by the time it is known the
 * artifact exists on disk saying `armed`. Returning an error and walking away
 * would leave a `run.md` no arm ever registered -- which is precisely the "sits
 * armed on disk and is invisible to the sweep forever" failure this module's
 * docstring exists to prevent, arriving through the safety check.
 *
 * PAUSED RATHER THAN ABORTED. Aborting is terminal and stamps an `abortReason`
 * a human then has to clear; the cause here is a DEPLOY, so the honest end state
 * is the one a rebuilt bundle plus a re-arm walks straight out of. It is also
 * the same shape `capBeat` parks a live run into for the same condition.
 *
 * THE REASON LANDS IN THREE PLACES and none of them is a return value: the
 * broker log (`docker logs broker`), the baton (where the next werk-master
 * generation reads it), and the caller. A refusal only the HTTP caller sees is a
 * refusal nobody finds three days later.
 */
async function unarm(store: ConversationStore, input: ArmEpicInput, reason: string): Promise<ArmEpicResult> {
  console.error(`[epic-arm] ${input.project} ${input.epicId} -- ${reason}`)
  const paused = await sendEpicOp(store, input.project, { op: 'pause', epicId: input.epicId, reason })
  // The sweep must not learn about this run under any circumstances, including
  // one where the pause itself failed -- an unregistered armed run is inert,
  // and a registered one with unenforceable ceilings is the outage.
  forgetArmedEpic(input.project, input.epicId)
  await appendBaton(store, input.project, input.epicId, { kind: 'checkpoint', convId: 'broker', body: reason })
  const stuck = paused.ok ? '' : ` (and the pause failed: ${paused.error ?? 'unknown'} -- run.md still says armed)`
  return { ok: false, error: `${reason}${stuck}`, status: 502 }
}
