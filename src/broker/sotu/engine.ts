/**
 * SOTU distill engine (Phase 4) -- the activity-driven trigger.
 *
 * The broker is the only thing that sees every contribution AND liveness, so the
 * trigger lives here. It subscribes to the in-process contribution stream
 * (`onContribution`) and decides, per project, WHEN to spend on a distill:
 *   - BURST: enough weighted contributions piled up AND the MIN_INTERVAL cost floor
 *     has elapsed -> distill now (a busy project keeps up).
 *   - QUIET_SETTLE: a trickle -> arm a trailing timer so a settling burst folds once.
 *   - MIN_INTERVAL: never distill more often than the floor (hard cost cap).
 *   - STALE_ON_READ: a read (panel open / SessionStart inject -- Phase 5) of a stale
 *     chronicle forces a fresh reconcile ("wither on return").
 *
 * The gates (project opt-in + budget) live in `runDistill`; this module owns only
 * the WHEN. The trigger constants (burst / min-interval / quiet-settle / stale-on-read)
 * are PER-PROJECT now (Phase 7): resolved from the project's config (`config.params`),
 * so a busy main-income project and an idle experiment tune independently. Idle
 * project -> no contributions -> zero timers -> zero cost.
 */

import { defaultResolveSotuConfig, type ResolveSotuConfig, type SotuProjectConfig } from './config'
import { onContribution } from './contribute'
import { type ChatFn, realChatFn } from './distill/llm'
import { type DistillDeps, type DistillOutcome, runDistill } from './distill/run'
import { projectSlug } from './paths'
import { readState } from './state'

export interface SotuEngineDeps {
  /** Injected chat fn (production = the real OpenRouter client; tests stub it). */
  chat?: ChatFn
  broadcast: (message: Record<string, unknown>, project: string) => void
  resolveConfig?: ResolveSotuConfig
  now?: () => number
  log?: (msg: string) => void
}

interface TriggerThresholds {
  burst: number
  minIntervalMs: number
  quietSettleMs: number
}

/** The trigger thresholds for a project come straight from its resolved tuning. */
function thresholdsFor(config: SotuProjectConfig): TriggerThresholds {
  return {
    burst: config.params.burstThreshold,
    minIntervalMs: config.params.minIntervalMs,
    quietSettleMs: config.params.quietSettleMs,
  }
}

export type TriggerAction = { action: 'now' } | { action: 'arm'; delayMs: number } | { action: 'none' }

/** PURE trigger policy: given the weighted pending count + time since the last
 *  distill, decide to fire now (busy + past the cost floor), arm a trailing timer
 *  (trickle / still inside the floor), or do nothing (nothing pending). */
export function decideTrigger(pending: number, elapsedMs: number, t: TriggerThresholds): TriggerAction {
  if (pending <= 0) return { action: 'none' }
  if (pending >= t.burst && elapsedMs >= t.minIntervalMs) return { action: 'now' }
  return { action: 'arm', delayMs: Math.max(t.quietSettleMs, t.minIntervalMs - elapsedMs) }
}

interface EngineState {
  deps: SotuEngineDeps
  distillDeps: DistillDeps
  resolveConfig: ResolveSotuConfig
  now: () => number
  timers: Map<string, ReturnType<typeof setTimeout>>
  inFlight: Set<string>
  unsubscribe: () => void
}

let current: EngineState | null = null

/** Start the engine: subscribe to the contribution stream + drive distills.
 *  Idempotent (a second call is a no-op while running). */
export function startSotuEngine(deps: SotuEngineDeps): void {
  if (current) return
  const now = deps.now ?? (() => Date.now())
  const distillDeps: DistillDeps = {
    chat: deps.chat ?? realChatFn,
    broadcast: deps.broadcast,
    now,
    ...(deps.log ? { log: deps.log } : {}),
  }
  const state: EngineState = {
    deps,
    distillDeps,
    resolveConfig: deps.resolveConfig ?? defaultResolveSotuConfig,
    now,
    timers: new Map(),
    inFlight: new Set(),
    unsubscribe: () => {},
  }
  state.unsubscribe = onContribution(ev => {
    if (!ev.project) return // no project -> nothing to resolve config / scope a broadcast to
    schedule(state, ev.slug, ev.project)
  })
  current = state
}

/** Stop the engine: unsubscribe + clear pending timers (clean shutdown + tests). */
export function stopSotuEngine(): void {
  if (!current) return
  current.unsubscribe()
  for (const t of current.timers.values()) clearTimeout(t)
  current.timers.clear()
  current = null
}

function schedule(state: EngineState, slug: string, project: string): void {
  const st = readState(slug)
  const config = state.resolveConfig(project)
  const decision = decideTrigger(st.pendingContribs, state.now() - st.lastDistillAt, thresholdsFor(config))
  if (decision.action === 'none') return
  if (decision.action === 'now') {
    void fire(state, slug, project, false)
    return
  }
  if (state.timers.has(slug)) return // coalesce: a fold is already armed for this project
  state.timers.set(
    slug,
    setTimeout(() => {
      state.timers.delete(slug)
      void fire(state, slug, project, false)
    }, decision.delayMs),
  )
}

/** Run one distill for a project, guarding against concurrent folds. If a fold is
 *  already running, re-arm a trailing timer so the new signal is not dropped. Resolves
 *  the project config FRESH at fire time (a delayed timer picks up edited tuning). */
async function fire(state: EngineState, slug: string, project: string, forceReconcile: boolean): Promise<void> {
  const config = state.resolveConfig(project)
  if (state.inFlight.has(slug)) {
    if (!state.timers.has(slug)) {
      state.timers.set(
        slug,
        setTimeout(() => {
          state.timers.delete(slug)
          void fire(state, slug, project, forceReconcile)
        }, config.params.quietSettleMs),
      )
    }
    return
  }
  state.inFlight.add(slug)
  try {
    await runDistill(state.distillDeps, { slug, project, config, forceReconcile })
  } catch (err) {
    state.deps.log?.(`[sotu] engine distill threw project=${project}: ${(err as Error)?.message ?? err}`)
  } finally {
    state.inFlight.delete(slug)
  }
}

/**
 * Read-triggered regen (Phase 5 read surfaces call this before serving). Forces a
 * fresh Opus reconcile when the chronicle is stale (the 24h-return case -- absorbed
 * work collapses, at-risk work surfaces); a cheap scribe when only new items pend.
 * No-op when fresh + nothing pending. Awaitable so a read serves the fresh doc.
 */
export async function maybeDistillOnRead(project: string): Promise<DistillOutcome | null> {
  if (!current) return null
  const state = current
  const slug = projectSlug(project)
  const st = readState(slug)
  const config = state.resolveConfig(project)
  const stale = state.now() - st.genAt > config.params.staleOnReadMs
  if (st.pendingContribs <= 0 && !stale) return null
  return runDistill(state.distillDeps, { slug, project, config, forceReconcile: stale })
}
