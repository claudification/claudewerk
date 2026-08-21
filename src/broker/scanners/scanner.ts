/**
 * THE SCANNER CONTRACT -- extracted from the epic sweep, which is the only sweep
 * in this codebase whose engine has completed an unattended run.
 *
 * There are five standing loops in the broker and three of them say, in their own
 * header comments, that they are copies of each other. This file is the shape all
 * five already have, written down once:
 *
 *   reads    the board + the conversation registry
 *   selects  by tag
 *   skips    anything with a live conversation
 *   refuses  into NAMED BUCKETS -- never a silent drop
 *   does     propose or dispatch
 *   is       self-catching, effects injected, no broker or sentinel to test it
 *
 * THE REFUSAL ROW IS THE ONE THAT EARNS ITS KEEP. `epic-ready.ts` already proved
 * the shape -- `waitingOnDeps`, `heldBack`, `questions`, `unspawnable`,
 * `idleReason`, each a named bucket, with the rule written in the file: "Named so
 * the ceiling is VISIBLE rather than silently truncating -- '3 of 7 running' is
 * the honest render." Here it is a REQUIRED return plus an accounting pass, so a
 * scanner that drops a unit without saying why is a type error at author time and
 * a loud log line at run time. "Log every refusal" stops being a discipline each
 * author has to remember.
 *
 * NOT A SCHEDULER. Nothing here owns a timer, a reentrancy guard or the restart
 * quarantine -- `werk-tick.ts` owns those and the epic sweep keeps its own. A
 * scanner is INVOKED; cadence stays with the caller.
 */

import type { Conversation } from '../../shared/protocol'
import type { ScannerId } from '../../shared/scanner-ids'
import type { IsLive } from '../werk-liveness'

/**
 * The effects every scanner needs, and nothing else.
 *
 * Deliberately four fields: a scanner that can be handed a conversation list, a
 * liveness predicate, a logger and a clock is a scanner every branch of which is
 * exercised without a broker, a sentinel or a CC process. That is epic-sweep's
 * own stated property ("A sweep that spawns nothing is still a sweep") and it is
 * why the epic sweep is the one that is actually tested.
 *
 * A concrete scanner extends this with its own effects -- board reads, spawns,
 * activity publishing. It never reaches for a module-level singleton to get them.
 */
export interface ScannerDeps {
  /** The whole registry, live and dead. Grouping is the scanner's own job. */
  getAllConversations: () => Conversation[]
  /** THE liveness rule (`werk-liveness.ts`), injected because only the registry
   *  knows whether a conversation still holds a socket. */
  isLive: IsLive
  log: (line: string) => void
  /** Injected so a scanner's clock is not the test's wall clock. */
  now: () => number
}

/**
 * One unit the scanner selected and did NOT act on, filed under a name.
 *
 * `bucket` is drawn from the scanner's declared vocabulary rather than being free
 * text: a free-text reason is a log line, and a log line is exactly the thing
 * nobody aggregates. A closed union is something a pane can count.
 */
export interface Refusal<Bucket extends string = string> {
  /** The unit refused -- a card id, a task id, an epic id. */
  unit: string
  /** WHICH named bucket. One of the scanner's `buckets`. */
  bucket: Bucket
  /** One line of why, for the log and the pane. */
  detail: string
}

/**
 * What one scan pass did. Every field but `idleReason` is REQUIRED, and that is
 * the whole point: `selected` is the denominator, `acted` and `refused` must
 * together cover it, and `runScan` says so out loud when they do not.
 */
export interface ScanOutcome<Bucket extends string = string> {
  /** Every unit this pass looked at, after selection. */
  selected: readonly string[]
  /** Units the scan proposed or dispatched. */
  acted: readonly string[]
  /** Every selected unit NOT acted on, each in a named bucket. An empty array is
   *  a legal answer; a MISSING unit is not. */
  refused: readonly Refusal<Bucket>[]
  /** Why the whole pass did nothing, when it did nothing. Goes into the log and,
   *  for the engines that have one, the baton. */
  idleReason?: string
}

/**
 * THE BUCKET FOR "THE DISPATCH ITSELF DID NOT HAPPEN", owned here and spelled
 * once.
 *
 * Every dispatching scanner needs it, and two of them had already written the
 * string out by hand. A third would have been free to spell it `dispatch_failed`
 * or `spawn-refused` and nothing would have noticed until a pane tried to count
 * the column. Scanners compose their own vocabulary from this type
 * ({@link DispatchFailedBucket}) rather than restating the literal, so the name
 * cannot drift.
 */
export const DISPATCH_FAILED_BUCKET = 'dispatch-failed'

/** The bucket name as a type, for a scanner's own `Bucket` union to include. */
export type DispatchFailedBucket = typeof DISPATCH_FAILED_BUCKET

/**
 * One thing to dispatch: what to call it in the accounting, and how to send it.
 *
 * `send` is a thunk rather than a request object because the two scanners
 * compile their seats differently -- one runs a card through `applyOrderToRequest`
 * ahead of time, the other builds a spawn plan at the call. What the shared tail
 * owns is the RESULT handling, which is the part they had written twice.
 */
export interface DispatchUnit {
  /** The unit id -- a card slug. What lands in `acted` or in the refusal. */
  id: string
  /** Send it. `false` means the spawn was refused. May throw; the tail catches. */
  send: () => Promise<boolean>
}

/** Where a dispatch pass files its results. The scanner's own two accumulators,
 *  handed in so the tail appends rather than returning a third thing to merge. */
export interface DispatchSink<Bucket extends string> {
  acted: string[]
  refused: Refusal<Bucket>[]
}

/**
 * DISPATCH, CATCH, AND FILE THE RESULT -- the tail every dispatching scanner
 * ends with, written once.
 *
 * Three rules, and all three were already the behaviour both scanners had
 * hand-rolled:
 *
 *   1. A THROW IS A REFUSAL, not a crash. One spawn that blows up must not cost
 *      the rest of the pass its dispatches, and `runScan`'s catch is too coarse
 *      for that -- it would lose every unit after the throwing one.
 *   2. `false` IS A REFUSAL TOO. A dispatch nobody accepted moved nothing, so it
 *      is refused into {@link DISPATCH_FAILED_BUCKET} rather than counted as
 *      acted on.
 *   3. SEQUENTIAL, deliberately. These are spawns; firing a backlog of them
 *      concurrently is how a ceiling that was already checked stops meaning
 *      anything.
 */
export async function dispatchUnits<Bucket extends string>(
  units: readonly DispatchUnit[],
  ctx: { tag: string; log: (line: string) => void },
  sink: DispatchSink<Bucket | DispatchFailedBucket>,
): Promise<void> {
  for (const unit of units) {
    const ok = await unit.send().catch(err => {
      ctx.log(`${ctx.tag} dispatch threw for ${unit.id}: ${err instanceof Error ? err.message : String(err)}`)
      return false
    })
    if (ok) sink.acted.push(unit.id)
    else sink.refused.push({ unit: unit.id, bucket: DISPATCH_FAILED_BUCKET, detail: 'the spawn was refused' })
  }
}

/**
 * A scanner. Generic over its deps and its refusal vocabulary so the vocabulary
 * is checked at the call site: a scanner cannot invent a bucket name in one
 * branch that nothing else knows about.
 */
export interface Scanner<Deps extends ScannerDeps, Bucket extends string = string> {
  id: ScannerId
  /** Log prefix, e.g. `[epic-sweep]`. Every line this scanner emits carries it. */
  tag: string
  /**
   * What this scanner selects, in one human phrase. Usually a board tag
   * (`#needs-refine`); the epic scanner selects by launch tag plus the armed
   * registry, so it says that instead of pretending to be tag-driven.
   */
  selects: string
  /** Propose (a morning report) or dispatch (epic, nightshift, refine). */
  does: 'propose' | 'dispatch'
  /** The COMPLETE refusal vocabulary, declared up front so a reader can see every
   *  way this scanner can decline without reading its body. */
  buckets: readonly Bucket[]
  /** One pass. May throw -- `runScan` is the self-catching part. */
  scan: (deps: Deps) => Promise<ScanOutcome<Bucket>>
}

/** What `runScan` gives back: the scan's own outcome plus the accounting. */
export interface ScanReport<Bucket extends string = string> extends ScanOutcome<Bucket> {
  scanner: ScannerId
  /**
   * Selected units that were neither acted on nor refused. ALWAYS EMPTY in a
   * correct scanner -- a non-empty array is precisely the silent drop this
   * contract exists to stop, surfaced instead of shipped quietly.
   */
  unaccounted: readonly string[]
  /** The scan threw. The message, so a caller can say which scanner died. */
  crashed?: string
}

/** Selected minus acted minus refused. Exported because it is the rule, and a
 *  rule worth enforcing is worth testing on its own. */
export function unaccountedUnits<Bucket extends string>(outcome: ScanOutcome<Bucket>): string[] {
  const covered = new Set<string>([...outcome.acted, ...outcome.refused.map(r => r.unit)])
  return outcome.selected.filter(unit => !covered.has(unit))
}

const EMPTY_OUTCOME: ScanOutcome<string> = { selected: [], acted: [], refused: [] }

/**
 * INVOKE ONE SCANNER. Self-catching, and the accounting pass is not optional.
 *
 * Self-catching for the reason every one of the five loops already gives in its
 * own header: a crash inside one sweep must never take the broker down, and must
 * never wedge the caller's guard. The caller gets a report either way.
 *
 * Quiet on the happy path ON PURPOSE. This runs every 45 seconds; the only two
 * lines it can emit are a crash and an accounting leak, neither of which fires in
 * a healthy tick. A per-tick summary here would drown the per-unit lines the
 * scanners already write.
 */
export async function runScan<Deps extends ScannerDeps, Bucket extends string>(
  scanner: Scanner<Deps, Bucket>,
  deps: Deps,
): Promise<ScanReport<Bucket>> {
  let outcome: ScanOutcome<Bucket>
  try {
    outcome = await scanner.scan(deps)
  } catch (err) {
    const crashed = err instanceof Error ? err.message : String(err)
    deps.log(`${scanner.tag} scan crashed -- swallowing: ${crashed}`)
    return { ...(EMPTY_OUTCOME as ScanOutcome<Bucket>), scanner: scanner.id, unaccounted: [], crashed }
  }

  const unaccounted = unaccountedUnits(outcome)
  if (unaccounted.length > 0) {
    // LOUD, because this is the failure the whole contract is aimed at: a unit
    // the scanner looked at, did nothing about, and never named a reason for.
    deps.log(
      `${scanner.tag} DROPPED ${unaccounted.length} unit(s) with no reason given: ${unaccounted.join(', ')} ` +
        `-- every selected unit must be acted on or refused into one of [${scanner.buckets.join(', ')}]`,
    )
  }
  return { ...outcome, scanner: scanner.id, unaccounted }
}
