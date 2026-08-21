/**
 * WHAT THE PARKED TILE SAYS -- and when it pulses.
 *
 * An unread report is exactly the "something is waiting for you" case the dock
 * tile's activity was built for: you park the brew, walk off, and the next
 * morning's sweep lands while nobody is looking. The `tick` is the REPORT DATE,
 * so a fresh brew advances it once and blinks once; a re-render does not.
 *
 * Ordered deliberately: a failure outranks a run, a run outranks a report, and
 * "no brew at all" is said out loud rather than rendered as an idle surface --
 * a missing morning report is the one health signal this whole feature has.
 *
 * Pure, so the ordering can be tested without mounting anything.
 */

import type { SurfaceActivityInput } from '@/hooks/modal-manager-types'
import type { MorningReportState } from './use-morning-report'

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function morningReportActivity(state: MorningReportState): SurfaceActivityInput {
  if (state.error) return { status: 'error', label: state.error }
  if (state.executing) return { status: 'running', label: 'executing', tick: state.report?.date }
  if (state.loading && !state.report) return { status: 'running', label: 'reading the brew' }

  const report = state.report
  // NOT idle. "No brew has ever arrived" is the failure this surface exists to
  // make visible, and an idle tile is how it would hide.
  if (!report) return { status: 'error', label: 'no report yet' }

  const executable = report.proposals.filter(p => p.kind !== 'note-delete-at').length
  const label = report.skipped
    ? `${report.date}: nothing moved`
    : executable === 0
      ? `${report.date}: no proposals`
      : `${report.date}: ${plural(executable, 'proposal')}`
  // `tick` is the report's DATE: it advances exactly once per new brew, which is
  // exactly how often the tile should blink.
  return { status: 'done', label, tick: report.date }
}
