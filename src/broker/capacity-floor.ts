/**
 * CAPACITY FLOOR -- the time-aware reserved slice (plan-quest-engine §9c).
 *
 * A pure function. The headroom ledger (`capacity-ledger.ts`) reserves a floor
 * of the window budget for daytime interactive use (the Quest Giver), so an
 * unattended run never drains the account to the interactive gate. The floor is
 * TIME-AWARE: it ramps UP toward the end of the run window ("morning") so the
 * last of the capacity is protected for the waking user -- stingier toward
 * morning, per §9c.
 *
 * Kept pure + separate so the ramp is trivially unit-testable with no ledger,
 * no clock, no oracle: everything is passed in.
 */

/** Tunables for the reserved floor. All fractions are of the window budget. */
export interface CapacityFloorConfig {
  /** Base reserved floor as a fraction of the window token budget, [0, 1). */
  baseFloorFraction: number
  /** Multiplier the floor reaches at the very end of the run window (morning).
   *  `2` = "floor doubles in the final rampHours" (§9c example). <= 1 disables the ramp. */
  morningRampMultiplier: number
  /** Hours before the window end over which the floor ramps linearly from base
   *  to base*multiplier. <= 0 disables the ramp. */
  rampHours: number
}

/** Recommended defaults: reserve 10% of the window, doubling to 20% in the last
 *  2h of the run window. Conservative -- the real gate is still the smart-balance
 *  5h interactive cap; this floor is the additional unattended-run cushion. */
export const DEFAULT_CAPACITY_FLOOR: CapacityFloorConfig = {
  baseFloorFraction: 0.1,
  morningRampMultiplier: 2,
  rampHours: 2,
}

const HOUR_MS = 60 * 60 * 1000

/** Clamp a floor fraction into a sane reservable range: never negative, never
 *  the whole budget (>= 1 would make admission impossible even at 0% used). */
function clampFraction(f: number): number {
  if (!Number.isFinite(f) || f <= 0) return 0
  return Math.min(0.95, f)
}

/**
 * The reserved floor fraction at time `now`, ramping toward `windowEndMs`.
 *
 * - No `windowEndMs` (or ramp disabled) -> flat `baseFloorFraction`.
 * - `now` earlier than `rampHours` before the end -> flat base.
 * - Inside the final `rampHours` -> linear ramp base -> base*multiplier.
 * - At/after the window end -> the full ramped peak.
 *
 * Pure: no side effects, no ambient clock.
 */
export function timeAwareFloorFraction(cfg: CapacityFloorConfig, now: number, windowEndMs?: number): number {
  const base = clampFraction(cfg.baseFloorFraction)
  const rampDisabled = windowEndMs === undefined || cfg.rampHours <= 0 || cfg.morningRampMultiplier <= 1
  if (rampDisabled) return base

  const peak = clampFraction(base * cfg.morningRampMultiplier)
  const rampMs = cfg.rampHours * HOUR_MS
  const msLeft = (windowEndMs as number) - now
  if (msLeft >= rampMs) return base // before the ramp starts
  if (msLeft <= 0) return peak // window is over -- hold the peak

  // Linear: msLeft == rampMs -> base ; msLeft == 0 -> peak.
  const progressed = (rampMs - msLeft) / rampMs // (0, 1)
  return base + (peak - base) * progressed
}
