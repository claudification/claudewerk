/**
 * Pure period helpers for the recap config modal: the preset list + the
 * retrospect-default rule. Kept free of React so the logic is unit-testable.
 */

import type { RecapPeriodLabel } from '@shared/protocol'

export interface RecapPreset {
  label: RecapPeriodLabel
  display: string
}

/** The quick presets offered in the modal (custom range is handled separately
 *  by the modal's date inputs). */
export const RECAP_PRESETS: RecapPreset[] = [
  { label: 'today', display: 'Today' },
  { label: 'yesterday', display: 'Yesterday' },
  { label: 'last_7', display: 'Last 7 days' },
  { label: 'last_30', display: 'Last 30 days' },
  { label: 'this_week', display: 'This week' },
  { label: 'this_month', display: 'This month' },
]

const DAY_MS = 24 * 60 * 60 * 1000
const RETROSPECT_MIN_DAYS = 7

/** Approximate span in days, used only for the retrospect-default decision.
 *  Presets map to their nominal length; custom uses the inclusive picked range. */
export function periodSpanDays(label: RecapPeriodLabel, startMs?: number, endMs?: number): number {
  switch (label) {
    case 'today':
    case 'yesterday':
      return 1
    case 'last_7':
    case 'this_week':
      return 7
    case 'last_30':
    case 'this_month':
      return 30
    case 'custom':
      if (startMs == null || endMs == null || endMs < startMs) return 0
      return Math.round((endMs - startMs) / DAY_MS) + 1
  }
}

/** Retrospect (went well / went badly / recommendations) defaults ON for periods
 *  of a week or more -- that's where an evaluative pass earns its cost; a single
 *  day doesn't. The user can always override the default in the modal. */
export function retrospectDefault(label: RecapPeriodLabel, startMs?: number, endMs?: number): boolean {
  return periodSpanDays(label, startMs, endMs) >= RETROSPECT_MIN_DAYS
}
