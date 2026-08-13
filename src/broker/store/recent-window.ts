/**
 * recent-window - the "how much history is worth showing" rule, in one place.
 *
 * The project summary page lists ended conversations, and the honest bound is
 * neither a pure count nor a pure age. A count alone truncates a busy day; an
 * age alone returns nothing for a project that has been quiet for a month. So
 * the window is the UNION: the newest `minCount`, OR everything still inside
 * `withinMs`, whichever reaches further back.
 *
 * Both store drivers implement the same rule, so it lives here rather than
 * being written twice and drifting.
 */

/** Newest 50, or the last 5 days, whichever is more. */
export const DEFAULT_RECENT_MIN_COUNT = 50
const DEFAULT_RECENT_WITHIN_MS = 5 * 24 * 60 * 60 * 1000
/**
 * Absolute ceiling. A project with 842 ended conversations in five days must
 * not be able to turn one panel open into an unbounded payload.
 */
export const DEFAULT_RECENT_HARD_CAP = 500

export interface RecentWindow {
  /** Always return at least this many, however old they are. */
  minCount: number
  /** Also return anything at least this recent, however many there are. */
  withinMs: number
  /** Never return more than this, whatever the other two say. */
  hardCap: number
}

export function resolveRecentWindow(partial?: Partial<RecentWindow>): RecentWindow {
  return {
    minCount: partial?.minCount ?? DEFAULT_RECENT_MIN_COUNT,
    withinMs: partial?.withinMs ?? DEFAULT_RECENT_WITHIN_MS,
    hardCap: partial?.hardCap ?? DEFAULT_RECENT_HARD_CAP,
  }
}

/**
 * How many rows to take, given how many fall inside the age window.
 *
 * Kept separate from any storage concern so it can be asserted directly -- the
 * union semantics are the part that is easy to get subtly wrong.
 */
export function recentLimit(window: RecentWindow, countWithinWindow: number): number {
  return Math.min(window.hardCap, Math.max(window.minCount, countWithinWindow))
}

/** Cutoff timestamp for the age half of the rule. */
export function recentCutoff(window: RecentWindow, now: number): number {
  return now - window.withinMs
}
