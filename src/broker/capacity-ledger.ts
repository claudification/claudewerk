/**
 * CAPACITY LEDGER -- headroom admission + reservations (plan-quest-engine §9).
 *
 * Adds CAPACITY admission on top of the orchestrator's concurrency caps: every
 * dispatch reserves an estimate so N parallel dispatches can't collectively
 * overshoot the smart-balance interactive gate. The arithmetic (available =
 * headroom - outstanding - floor) lives in `capacity-math.ts` (pure); this class
 * owns the RESERVATION STATE + emits the structured decisions. Smart-balance is
 * the ORACLE -- consume, never re-derive.
 *
 * §14 RECOVERABILITY -- reservations are a CACHE, not truth: `reconstructLedger`
 * (capacity-recovery.ts) rebuilds outstanding from the in-flight nightshift
 * conversations on boot (derive-from-convs over kv persistence: simpler AND more
 * truthful), so a broker restart mid-run never loses or double-counts capacity.
 */

import type { CapacityDecision } from '../shared/protocol'
import { fmt, recordDecision } from './capacity-decision'
import { computeSleep, floorTokens, headroomTokens, pickBest } from './capacity-math'
import type { AdmitResult, CapacityConfig, HeadroomOracle, LedgerDeps, TaskCtx } from './capacity-types'

interface Reservation {
  taskRef: string
  profile: string
  estimateTokens: number
  reservedAt: number
  ctx: TaskCtx
}

/**
 * The reservation ledger. One instance per broker (module singleton, wired in
 * index.ts). Pure of I/O -- all side effects go through `emit`.
 */
export class CapacityLedger {
  private readonly reservations = new Map<string, Reservation>()
  private readonly config: CapacityConfig
  private readonly oracle: HeadroomOracle
  private readonly emit: (d: CapacityDecision) => void
  private readonly now: () => number

  constructor(deps: LedgerDeps) {
    this.config = deps.config
    this.oracle = deps.oracle
    this.emit = deps.emit
    this.now = deps.now ?? Date.now
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  get defaultEstimate(): number {
    return this.config.defaultEstimateTokens
  }

  outstandingTokens(profile: string): number {
    let sum = 0
    for (const r of this.reservations.values()) if (r.profile === profile) sum += r.estimateTokens
    return sum
  }

  /** The emptiest candidate profile + its available capacity (oracle-driven). */
  private bestFor(candidates: string[], now: number, windowEndMs?: number) {
    return pickBest(this.config, this.oracle, candidates, p => this.outstandingTokens(p), now, windowEndMs)
  }

  /** Admit against the emptiest candidate: if the estimate fits, RESERVE + admit;
   *  else leave queued (deny) with a computed wake from window roll-off (§9d). */
  admitBest(
    ctx: TaskCtx,
    candidates: string[],
    estimateTokens: number,
    taskRef: string,
    opts: { now?: number; windowEndMs?: number } = {},
  ): AdmitResult {
    const now = opts.now ?? this.now()
    const { profile: best, avail } = this.bestFor(candidates, now, opts.windowEndMs)
    const floor = floorTokens(this.config, now, opts.windowEndMs)
    const outstanding = this.outstandingTokens(best)
    const headroom = headroomTokens(this.config, this.oracle, best)

    if (avail.tokens >= estimateTokens) {
      this.reserveInternal(ctx, best, estimateTokens, taskRef, now, {
        headroom: headroom.tokens,
        outstanding,
        floor,
        available: avail.tokens,
        fiveHourPct: avail.fiveHourPct,
      })
      return { admitted: true, profile: best }
    }

    const candList = candidates.length > 0 ? candidates : ['default']
    const sleepUntil = computeSleep(this.oracle, candList)
    recordDecision(this.emit, {
      ctx,
      profile: best,
      verdict: 'deny',
      at: now,
      estimateTokens,
      headroomTokens: headroom.tokens,
      outstandingTokens: outstanding,
      floorTokens: floor,
      availableTokens: avail.tokens,
      fiveHourPct: avail.fiveHourPct,
      sleepUntil,
      reason:
        `deny: need ${fmt(estimateTokens)} tok, only ${fmt(avail.tokens)} available on ${best} ` +
        `(headroom ${fmt(headroom.tokens)} - outstanding ${fmt(outstanding)} - floor ${fmt(floor)})` +
        (sleepUntil ? `; wake at ${new Date(sleepUntil).toISOString()}` : ''),
    })
    return { admitted: false, sleepUntil }
  }

  /** Explicit reservation (used by reconstruction). */
  reserve(ctx: TaskCtx, profile: string, estimateTokens: number, taskRef: string, reason?: string): void {
    this.reserveInternal(ctx, profile, estimateTokens, taskRef, this.now(), undefined, reason)
  }

  private reserveInternal(
    ctx: TaskCtx,
    profile: string,
    estimateTokens: number,
    taskRef: string,
    now: number,
    terms?: { headroom: number; outstanding: number; floor: number; available: number; fiveHourPct?: number },
    reason?: string,
  ): void {
    this.reservations.set(taskRef, { taskRef, profile, estimateTokens, reservedAt: now, ctx })
    recordDecision(this.emit, {
      ctx,
      profile,
      verdict: 'reserve',
      at: now,
      estimateTokens,
      headroomTokens: terms?.headroom,
      outstandingTokens: terms?.outstanding,
      floorTokens: terms?.floor,
      availableTokens: terms?.available,
      fiveHourPct: terms?.fiveHourPct,
      reason: reason ?? `reserve ${fmt(estimateTokens)} tok on ${profile} (${taskRef})`,
    })
  }

  /** Release a reservation once the task ends; `actualTokens` is folded for the
   *  log (real usage is already in the oracle's used% via polling). No-op if the
   *  taskRef was never reserved (e.g. admission was disabled at dispatch). */
  settle(taskRef: string, actualTokens?: number): void {
    const r = this.reservations.get(taskRef)
    if (!r) return
    this.reservations.delete(taskRef)
    recordDecision(this.emit, {
      ctx: r.ctx,
      profile: r.profile,
      verdict: 'settle',
      at: this.now(),
      estimateTokens: actualTokens ?? r.estimateTokens,
      reason:
        `settle ${taskRef} on ${r.profile}: reserved ${fmt(r.estimateTokens)} tok, ` +
        `actual ${actualTokens === undefined ? 'unknown' : `${fmt(actualTokens)} tok`}`,
    })
  }

  /** Emit a terminal starvation record for a task the window never admitted (§9f)
   *  and return the human reason for the SKIPPED card (ledger + card agree). */
  starve(
    ctx: TaskCtx,
    candidates: string[],
    estimateTokens: number,
    opts: { now?: number; windowEndMs?: number } = {},
  ): string {
    const now = opts.now ?? this.now()
    const { profile, avail } = this.bestFor(candidates, now, opts.windowEndMs)
    const floor = floorTokens(this.config, now, opts.windowEndMs)
    const reason =
      `capacity: needed ${fmt(estimateTokens)} tok, only ${fmt(avail.tokens)} available on ${profile} ` +
      `(floor ${fmt(floor)} reserved)`
    recordDecision(this.emit, {
      ctx,
      profile,
      verdict: 'starve',
      at: now,
      estimateTokens,
      availableTokens: avail.tokens,
      floorTokens: floor,
      fiveHourPct: avail.fiveHourPct,
      reason,
    })
    return reason
  }
}
