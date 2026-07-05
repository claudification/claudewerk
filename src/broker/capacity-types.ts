/**
 * CAPACITY ADMISSION -- shared types + config (plan-quest-engine §9).
 *
 * The admission accounting unit is TOKENS. Smart-balance is the ORACLE (5h
 * interactive gate); we CONSUME its percentage telemetry and bridge token
 * estimates onto it via `windowTokenBudget` (the one tunable that maps a token
 * estimate onto the 5h window -- an accounting basis, NOT a measured plan limit).
 * See `capacity-ledger.ts` for the reservation mechanics + §14 recoverability.
 */

import type { CapacityDecision } from '../shared/protocol'
import type { CapacityFloorConfig } from './capacity-floor'
import { DEFAULT_CAPACITY_FLOOR } from './capacity-floor'

/** Admission accounting config. `enabled` OFF -> the orchestrator skips the
 *  ledger entirely (pure concurrency dispatch, today's behaviour). */
export interface CapacityConfig {
  enabled: boolean
  /** Tokens that fill a 5h window from 0% to 100% -- the token<->percent bridge.
   *  Accounting basis (tunable), NOT a measured plan limit. */
  windowTokenBudget: number
  /** Default per-task estimate when a task declares no `estimate_tokens` (§9b). */
  defaultEstimateTokens: number
  floor: CapacityFloorConfig
}

export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  enabled: false,
  windowTokenBudget: 10_000_000,
  defaultEstimateTokens: 50_000,
  floor: DEFAULT_CAPACITY_FLOOR,
}

/** A fresh oracle reading for one profile, or `null` when telemetry is
 *  unreadable / stale / errored -> the ledger FAILS CLOSED (headroom 0, §9e). */
export interface ProfileHeadroomReading {
  /** 5h window utilisation, percentage [0,100]. */
  fiveHourPct: number
  /** Epoch ms the 5h window resets (headroom recovers). Absent -> can't compute
   *  a wake time for this profile. */
  resetAtMs?: number
}

/** Smart-balance telemetry seam. Injected so tests stub it (like the watchdog's
 *  getSentinelProfileUsage). CONSUME only -- never re-derive capacity here. */
export type HeadroomOracle = (profile: string) => ProfileHeadroomReading | null

/** Identity carried on every decision so the log/message reconstructs the flow. */
export interface TaskCtx {
  project: string
  runId: string
  taskId: string
}

/** A finished/in-flight nightshift conversation, narrowed to what boot
 *  reconstruction needs (§14). */
export interface InflightConvView {
  id: string
  project: string
  resolvedProfile?: string
  /** input+output tokens consumed so far. */
  usedTokens: number
  nightshift: { runId: string; taskId: string }
}

export interface AdmitResult {
  admitted: boolean
  /** The profile the estimate was reserved against (admitted only). */
  profile?: string
  /** Computed wake time (epoch ms) when denied and a reset clock is known (§9d). */
  sleepUntil?: number
}

export interface LedgerDeps {
  config: CapacityConfig
  oracle: HeadroomOracle
  /** Structured-message sink (broadcast + persist). */
  emit: (decision: CapacityDecision) => void
  /** Injectable clock. */
  now?: () => number
}
