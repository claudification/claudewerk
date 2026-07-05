/**
 * CAPACITY MATH -- the pure accounting behind the ledger (plan-quest-engine §9).
 *
 * Pure functions: given the config, an oracle reading source, and the current
 * outstanding-reservations figure, compute headroom / floor / available and pick
 * the emptiest candidate profile. No state, no I/O -- so the admission arithmetic
 * is unit-testable without a ledger. Smart-balance is the ORACLE; we CONSUME the
 * 5h used% + reset clock and never re-derive capacity.
 */

import { GATE_FIVE_HOUR_PCT } from '../sentinel/selection'
import { timeAwareFloorFraction } from './capacity-floor'
import type { CapacityConfig, HeadroomOracle } from './capacity-types'

export interface Headroom {
  tokens: number
  /** Fresh 5h utilisation %, or undefined when telemetry was unreadable. */
  fiveHourPct?: number
}

/** Headroom in tokens before the interactive gate, or 0 when telemetry is
 *  unreadable (FAIL CLOSED, §9e). */
export function headroomTokens(cfg: CapacityConfig, oracle: HeadroomOracle, profile: string): Headroom {
  const reading = oracle(profile)
  if (!reading) return { tokens: 0 } // fail closed -- can't confirm the gate
  const pct = clampPct(reading.fiveHourPct)
  const room = Math.max(0, GATE_FIVE_HOUR_PCT - pct)
  return { tokens: (cfg.windowTokenBudget * room) / 100, fiveHourPct: pct }
}

/** The reserved floor in tokens at `now` (time-aware, §9c). */
export function floorTokens(cfg: CapacityConfig, now: number, windowEndMs?: number): number {
  return cfg.windowTokenBudget * timeAwareFloorFraction(cfg.floor, now, windowEndMs)
}

/** available = headroom - outstanding - floor, clamped >= 0. */
function availableTokens(
  cfg: CapacityConfig,
  oracle: HeadroomOracle,
  profile: string,
  outstanding: number,
  now: number,
  windowEndMs?: number,
): Headroom {
  const h = headroomTokens(cfg, oracle, profile)
  const avail = h.tokens - outstanding - floorTokens(cfg, now, windowEndMs)
  return { tokens: Math.max(0, avail), fiveHourPct: h.fiveHourPct }
}

/** Pick the candidate with the most available capacity (the emptiest profile). */
export function pickBest(
  cfg: CapacityConfig,
  oracle: HeadroomOracle,
  candidates: string[],
  outstandingFor: (profile: string) => number,
  now: number,
  windowEndMs?: number,
): { profile: string; avail: Headroom } {
  const profiles = candidates.length > 0 ? candidates : ['default']
  let best = profiles[0]
  let bestAvail = availableTokens(cfg, oracle, best, outstandingFor(best), now, windowEndMs)
  for (let i = 1; i < profiles.length; i++) {
    const a = availableTokens(cfg, oracle, profiles[i], outstandingFor(profiles[i]), now, windowEndMs)
    if (a.tokens > bestAvail.tokens) {
      best = profiles[i]
      bestAvail = a
    }
  }
  return { profile: best, avail: bestAvail }
}

/** Earliest wall-clock time headroom recovers for ANY candidate: once a 5h
 *  window resets, used% drops and headroom jumps to full, covering any single
 *  task. Undefined when no candidate exposes a reset clock (fail-closed / stale)
 *  -> caller falls back to the next orchestrator tick. */
export function computeSleep(oracle: HeadroomOracle, candidates: string[]): number | undefined {
  let earliest: number | undefined
  for (const p of candidates) {
    const reset = oracle(p)?.resetAtMs
    if (reset === undefined) continue
    if (earliest === undefined || reset < earliest) earliest = reset
  }
  return earliest
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 100 // unreadable number -> treat as fully used (fail closed)
  return Math.max(0, Math.min(100, p))
}
