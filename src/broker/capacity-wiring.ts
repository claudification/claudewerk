/**
 * CAPACITY WIRING -- builds the real capacity ledger from the store and rebuilds
 * its reservations on boot (plan-quest-engine §9 + §14).
 *
 * The ORACLE reads smart-balance telemetry (`getSentinelProfileUsage`): a
 * profile's freshest 5h used% + reset clock across every connected sentinel. We
 * CONSUME it -- never re-derive. Fail closed (§9e): no fresh reading anywhere ->
 * null -> the ledger treats headroom as 0. Admission is OFF unless
 * `CLAUDWERK_CAPACITY_ADMISSION` is set, so the default deployment keeps today's
 * pure-concurrency behaviour.
 */

import type { CapacityDecision, CapacityLedgerEvent, ProfileUsageSnapshot } from '../shared/protocol'
import { CapacityLedger } from './capacity-ledger'
import { reconstructLedger } from './capacity-recovery'
import {
  DEFAULT_CAPACITY_CONFIG,
  type HeadroomOracle,
  type InflightConvView,
  type ProfileHeadroomReading,
} from './capacity-types'
import type { ConversationStore } from './conversation-store'
import { configureCapacityAdmission } from './nightshift-orchestrator'

/** A profile reading older than this is ignored (fail closed) -- we can't honour
 *  the interactive gate on stale telemetry. */
const STALE_MS = 15 * 60 * 1000

function envNum(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** A usable 5h reading from one snapshot, or null when unauthed/errored/stale.
 *  (CC 6 is the freshness guard; CRAP only inflated by zero estimated coverage.) */
// fallow-ignore-next-line complexity
function readingFrom(snap: ProfileUsageSnapshot | undefined): ProfileHeadroomReading | null {
  if (!snap || snap.error || snap.stale || !snap.fiveHour) return null
  const resetMs = Date.parse(snap.fiveHour.resetAt)
  return { fiveHourPct: snap.fiveHour.usedPercent, resetAtMs: Number.isFinite(resetMs) ? resetMs : undefined }
}

/** Freshest fivehour reading for `profile` across all sentinels, or null. */
function buildOracle(store: ConversationStore): HeadroomOracle {
  // trivial scan loop; CRAP inflated only by zero estimated coverage
  // fallow-ignore-next-line complexity
  return profile => {
    const now = Date.now()
    for (const s of store.getSentinels()) {
      const usage = store.getSentinelProfileUsage(s.sentinelId)
      if (!usage || now - usage.polledAt > STALE_MS) continue
      const reading = readingFrom(usage.profiles.find(p => p.profile === profile))
      if (reading) return reading
    }
    return null // fail closed (§9e)
  }
}

/** Construct the capacity ledger wired to the store (oracle + structured-message
 *  broadcast). Admission `enabled` is env-gated (default off). */
function buildCapacityLedger(store: ConversationStore): CapacityLedger {
  const enabled = /^(1|true|yes|on)$/i.test(process.env.CLAUDWERK_CAPACITY_ADMISSION ?? '')
  const config = {
    enabled,
    windowTokenBudget: envNum('CLAUDWERK_CAPACITY_WINDOW_TOKENS', DEFAULT_CAPACITY_CONFIG.windowTokenBudget),
    defaultEstimateTokens: envNum('CLAUDWERK_CAPACITY_ESTIMATE_TOKENS', DEFAULT_CAPACITY_CONFIG.defaultEstimateTokens),
    floor: DEFAULT_CAPACITY_CONFIG.floor,
  }
  console.log(
    `[capacity] admission ${enabled ? 'ENABLED' : 'disabled'} ` +
      `(windowBudget=${config.windowTokenBudget} defaultEstimate=${config.defaultEstimateTokens})`,
  )
  return new CapacityLedger({
    config,
    oracle: buildOracle(store),
    emit: (decision: CapacityDecision) => {
      const event: CapacityLedgerEvent = { type: 'capacity_ledger_event', project: decision.project, decision }
      store.broadcastConversationScoped(
        event as unknown as Parameters<typeof store.broadcastConversationScoped>[0],
        decision.project,
      )
    },
  })
}

/**
 * §14 boot reconstruction: rebuild outstanding reservations from the in-flight
 * nightshift conversations so a broker restart mid-run never loses or
 * double-counts reserved capacity. (CC 5 filter loop; CRAP inflated by zero
 * estimated coverage on this boot-wiring fn.)
 */
// fallow-ignore-next-line complexity
function reconstructCapacity(store: ConversationStore, ledger: CapacityLedger): void {
  const convs: InflightConvView[] = []
  for (const c of store.getActiveConversations()) {
    const tag = c.launchConfig?.nightshift
    if (!tag) continue
    convs.push({
      id: c.id,
      project: c.project,
      resolvedProfile: c.resolvedProfile,
      usedTokens: c.stats.totalInputTokens + c.stats.totalOutputTokens,
      nightshift: { runId: tag.runId, taskId: tag.taskId },
    })
  }
  if (convs.length === 0) return
  reconstructLedger(ledger, convs)
  console.log(`[capacity] reconstructed ${convs.length} reservation(s) from in-flight nightshift conversation(s)`)
}

/**
 * Wire capacity admission into the running broker: build the ledger, install it
 * on the orchestrator, and rebuild reservations from in-flight convs (§14).
 * One call so `index.ts` stays a single line (the god-file line-shift keeps the
 * `.fallow` baselines stable).
 */
export function wireCapacityAdmission(store: ConversationStore): void {
  const ledger = buildCapacityLedger(store)
  configureCapacityAdmission(ledger)
  reconstructCapacity(store, ledger)
}
