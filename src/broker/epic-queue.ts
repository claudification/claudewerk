/**
 * THE QUEUE GATE -- `when=queue`, decided for a whole project at once.
 *
 * Every other admission question an epic asks is about ITSELF: its ceilings, its
 * board, its window. This one is about the OTHERS -- "is anything else running?"
 * -- so it cannot be answered inside a single epic's beat, and it lives here as a
 * pure fold over every scope the sweep is about to look at.
 *
 * THE SEMANTICS, and there were two honest readings (see `runner-queue-verb`):
 *
 *   E-1 "starts last"          wait for every other run to reach a terminal
 *                              status, then arm normally and share from there.
 *                              A long-lived epic that never terminates means the
 *                              queued one NEVER runs.
 *   E-2 "exclusive while held" wait until no other scope has work in flight, then
 *                              HOLD the runner until this run goes dry, then
 *                              release. Interleaves at a coarse grain.
 *
 * E-2 is implemented, because it is what "only when there is no other epic
 * running" actually asks for and because it terminates. Round-robin is the
 * engine's default; `queue` is the deliberate opt-OUT of sharing, for an epic
 * that rewrites something everything else touches.
 *
 * TWO GATES FALL OUT OF ONE VERDICT, and both are returned by the same fold so
 * they can never disagree:
 *   - a QUEUED scope may not dispatch while anything else is busy, or while
 *     another queued scope is ahead of it;
 *   - every OTHER scope may not dispatch while a queued scope is HOLDING.
 *
 * IT GATES DISPATCH, NOT VERIFICATION, exactly as the `window` gate does. A held
 * scope keeps writing verdicts for work already done, which is what lets the
 * runner actually drain and the queued scope actually enter -- a gate that froze
 * verification too would deadlock on the first epic with a card in review.
 *
 * WHAT "HOLDING" IS, with no new state: a queued run holds the runner once it has
 * been PERMITTED TO DISPATCH, which `startedAt` already records ("the first beat
 * the run was permitted to dispatch, not when it was armed",
 * `epic-run-types.ts`). Arming clears it and an inert run releases, so going dry
 * -- which parks the run -- releases the hold by construction. A separate
 * `heldSince` field would be a second answer to a question `startedAt` already
 * answers correctly, free to drift.
 */

import type { EpicCadence, EpicRunStatus } from '../shared/epic-run-types'
import { gatedBy } from '../shared/epic-when'
import type { EpicQueueReading, EpicRunSnapshot } from '../shared/protocol'

/**
 * How long a queued scope may wait before the beat starts SHOUTING about it.
 *
 * The starvation this bounds is not hypothetical -- a queued epic behind a
 * never-draining one never runs -- and the failure is silent, which is the shape
 * of every other bug in this engine's history. So the same treatment the restart
 * quarantine gets: a countdown on every held tick, and a louder line once the
 * wait stops looking like scheduling and starts looking like starvation.
 *
 * 30 minutes because a beat is 45s: at that point the run has been passed over
 * forty times, which no amount of ordinary draining explains.
 */
export const QUEUE_PATIENCE_MS = 30 * 60_000

/**
 * One epic, as the queue fold needs to see it. Assembled from the two reads the
 * sweep already makes -- the run artifact and the conversation-derived group --
 * and nothing else.
 */
export interface QueueScope {
  epicId: string
  /** The run's `when` gates. Absent run (armed, nothing on disk) reads as `now`. */
  when: readonly EpicCadence[]
  /** `null` when no run artifact exists for an epic the sweep can still see. */
  status: EpicRunStatus | null
  /** `run.startedAt` -- has this run ever been permitted to dispatch? */
  started: boolean
  /** Does it hold seats RIGHT NOW: any implementer, verifier or live overseer. */
  busy: boolean
  /** `run.created`, the FIFO key. Ties break on `epicId` so the order is total. */
  created: string
  /** `run.updated`. For a run that has never started this is when it was armed,
   *  which is the only honest "waiting since" the artifact carries. */
  updated: string
}

/**
 * The two reads the sweep already makes, folded into one scope.
 *
 * `busy` counts a live OVERSEER as well as implementers and verifiers, and that
 * is deliberate: an overseer merges branches and rewrites cards, so an epic
 * armed to avoid colliding with the rest of the project has not got a quiet
 * runner while one is mid-generation. It is the conservative direction -- it can
 * only ever make a queued epic wait one more beat.
 *
 * A MISSING RUN reads as an ungated scope with no gates and no hold, which is
 * what an epic with conversations but nothing on disk actually is.
 */
export function toQueueScope(
  group: { epicId: string; project: string; inFlight: readonly string[]; overseerAlive: boolean },
  run: EpicRunSnapshot | null,
): ScopedQueueScope {
  return {
    epicId: group.epicId,
    project: group.project,
    when: run?.cadence ?? ['now'],
    status: run?.status ?? null,
    started: Boolean(run?.startedAt),
    busy: group.inFlight.length > 0 || group.overseerAlive,
    created: run?.created ?? '',
    updated: run?.updated ?? '',
  }
}

/** What the queue axis says about ONE scope this beat. */
export interface QueueVerdict {
  /** May this scope dispatch new work? False means the beat moves nothing. */
  blocked: boolean
  /** 1-based place in the queue of WAITING queued scopes; 0 when not one. */
  position: number
  /** How many queued scopes are waiting, this one included. */
  total: number
  /** What it is waiting on -- busy scopes, plus any queued scope ahead of it. */
  behind: readonly string[]
  /** The queued scope holding the runner, when THAT is what blocks this one. */
  heldBy?: string
  /** Milliseconds this scope has been waiting, when it is waiting. */
  waitingMs?: number
  /** One line, ready for the beat note, the log, `inspect` and the run rail.
   *  Null when the queue axis has nothing to say about this scope. */
  reason: string | null
}

const FREE: QueueVerdict = { blocked: false, position: 0, total: 0, behind: [], reason: null }

/** A scope plus the project it belongs to. The queue is a PROJECT's queue -- two
 *  projects' epics never compete for the same runner. */
export type ScopedQueueScope = QueueScope & { project: string }

/** `${project}\0${epicId}` -- the same NUL join the armed registry uses. */
function scopeKey(project: string, epicId: string): string {
  return `${project}\0${epicId}`
}

/**
 * Every project's queue, decided in one pass, behind a lookup.
 *
 * The grouping is here rather than at the call sites because BOTH readers -- the
 * sweep that acts on the verdict and the activity feed that reports it -- have to
 * reach the same answer from the same scopes. A feed that grouped differently
 * would be a run rail that lies about the engine by construction, which is the
 * exact failure `epicsToWatch` is shared to prevent.
 */
export function planProjectQueues(
  scopes: readonly ScopedQueueScope[],
  nowMs: number,
): { verdict: (project: string, epicId: string) => QueueVerdict } {
  const byProject = new Map<string, ScopedQueueScope[]>()
  for (const scope of scopes) {
    const list = byProject.get(scope.project) ?? []
    list.push(scope)
    byProject.set(scope.project, list)
  }
  const all = new Map<string, QueueVerdict>()
  for (const [project, list] of byProject) {
    for (const [epicId, verdict] of queueVerdicts(list, nowMs)) all.set(scopeKey(project, epicId), verdict)
  }
  return { verdict: (project, epicId) => all.get(scopeKey(project, epicId)) ?? FREE }
}

/**
 * The verdict as the wire carries it, or nothing when the axis has no opinion.
 *
 * The ABSENCE is the useful half: every ordinary run in every ordinary project
 * gets `undefined` here, so a surface can render the queue line by asking whether
 * there is one rather than by re-deriving "does this matter".
 */
export function toQueueReading(verdict: QueueVerdict): EpicQueueReading | undefined {
  if (!verdict.reason) return undefined
  return {
    blocked: verdict.blocked,
    position: verdict.position,
    total: verdict.total,
    ...(verdict.heldBy ? { heldBy: verdict.heldBy } : {}),
    reason: verdict.reason,
  }
}

/** Terminal and paused runs are touched by nothing, so they neither wait nor
 *  hold. Mirrors `isInertRun`, kept local so this fold stays a pure leaf. */
function inert(status: EpicRunStatus | null): boolean {
  return status === 'paused' || status === 'complete' || status === 'aborted'
}

function isQueued(scope: QueueScope): boolean {
  return gatedBy(scope.when, 'queue')
}

/** FIFO by arm time, ties on the id so two runs armed in the same millisecond
 *  still have a stable order -- a queue whose order jitters between beats would
 *  let two scopes both believe they are first. */
function fifo(a: QueueScope, b: QueueScope): number {
  return a.created.localeCompare(b.created) || a.epicId.localeCompare(b.epicId)
}

/**
 * How long since a stamp, never negative and never NaN.
 *
 * An unparseable or missing `updated` reads as ZERO WAIT rather than as a
 * NaN that would silently poison the starvation comparison: a run whose artifact
 * cannot be read has not been proven to be starving, and a gate that shouted
 * STARVING at every unreadable run would train the reader to ignore the word.
 */
function elapsedSince(stamp: string, nowMs: number): number {
  const at = Date.parse(stamp || '')
  return Number.isFinite(at) ? Math.max(0, nowMs - at) : 0
}

function humanMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function waitLine(v: { position: number; total: number; behind: readonly string[]; waitingMs: number }): string {
  const waited = humanMinutes(v.waitingMs)
  const starving = v.waitingMs >= QUEUE_PATIENCE_MS ? 'STARVING: ' : ''
  const behind = v.behind.length > 0 ? `, behind ${v.behind.join(', ')}` : ''
  return `${starving}queued, position ${v.position} of ${v.total}${behind} (waiting ${waited})`
}

/**
 * The whole project's queue verdict, one entry per scope.
 *
 * Takes every scope the sweep is about to beat, not just the queued ones: the
 * gate has two directions, and the answer for a non-queued epic ("held by X")
 * has to come out of the same fold as the answer for the queued one, or the two
 * could disagree about who holds the runner.
 */
export function queueVerdicts(scopes: readonly QueueScope[], nowMs: number): Map<string, QueueVerdict> {
  const live = scopes.filter(s => !inert(s.status))
  // A queued run that has been permitted to dispatch OWNS the runner until it
  // parks. `startedAt` is the permission stamp, so this needs no state of its own.
  const holders = live.filter(s => isQueued(s) && s.started)
  const waiting = live.filter(s => isQueued(s) && !s.started).sort(fifo)

  const out = new Map<string, QueueVerdict>()
  for (const scope of scopes) {
    out.set(scope.epicId, verdictFor(scope, { live, holders, waiting, nowMs }))
  }
  return out
}

interface FoldState {
  live: readonly QueueScope[]
  holders: readonly QueueScope[]
  waiting: readonly QueueScope[]
  nowMs: number
}

function verdictFor(scope: QueueScope, state: FoldState): QueueVerdict {
  if (inert(scope.status)) return FREE
  return isQueued(scope) ? queuedVerdict(scope, state) : heldVerdict(scope, state)
}

/**
 * A QUEUED scope: already holding, or waiting for a quiet runner and its turn.
 *
 * The turn half matters as much as the quiet half -- two queued epics with
 * nothing else running would otherwise both find the runner free on the same
 * beat and enter together, which is the one thing `queue` promises cannot happen.
 */
function queuedVerdict(scope: QueueScope, state: FoldState): QueueVerdict {
  const position = state.waiting.findIndex(s => s.epicId === scope.epicId) + 1
  const total = state.waiting.length

  // It holds the runner: nothing gates it, and it keeps the runner until it goes
  // dry (which parks it, which makes it inert, which releases the hold).
  if (scope.started) {
    return { blocked: false, position: 0, total, behind: [], reason: 'holding the runner exclusively (when=queue)' }
  }

  const busy = state.live.filter(s => s.epicId !== scope.epicId && s.busy).map(s => s.epicId)
  const ahead = state.waiting.slice(0, Math.max(position - 1, 0)).map(s => s.epicId)
  const holder = state.holders.find(h => h.epicId !== scope.epicId)
  const behind = [...new Set([...busy, ...ahead, ...(holder ? [holder.epicId] : [])])].sort()
  if (behind.length === 0) {
    return { blocked: false, position, total, behind: [], reason: 'the runner is free; taking it (when=queue)' }
  }

  const waitingMs = elapsedSince(scope.updated, state.nowMs)
  return {
    blocked: true,
    position,
    total,
    behind,
    ...(holder ? { heldBy: holder.epicId } : {}),
    waitingMs,
    reason: waitLine({ position, total, behind, waitingMs }),
  }
}

/**
 * A NON-QUEUED scope, while a queued one holds the runner.
 *
 * This is the half that makes `queue` mean anything. Without it a queued epic
 * would take a runner nobody had agreed to give up, and the epic it was armed to
 * avoid colliding with would dispatch straight into it on the next beat.
 *
 * It withholds NEW work only. Whatever this scope already has in flight runs to
 * completion and gets verified, which is exactly how the runner drains.
 */
function heldVerdict(scope: QueueScope, state: FoldState): QueueVerdict {
  const holder = state.holders.find(h => h.epicId !== scope.epicId)
  if (!holder) return FREE
  return {
    blocked: true,
    position: 0,
    total: state.waiting.length,
    behind: [holder.epicId],
    heldBy: holder.epicId,
    reason: `held: ${holder.epicId} has the runner exclusively (when=queue); in-flight work still finishes`,
  }
}
