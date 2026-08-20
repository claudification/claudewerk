/**
 * A9's report -- the whole matrix as pasteable text.
 *
 * IN ITS OWN FILE rather than in `stat-reports.ts`, where the other reading-pane
 * builders live. That file was already at 244 lines when this pane landed, past
 * the bar this repo splits at, and a seventh builder appended to it is exactly
 * the drift the bar exists to stop. Same spine (`wallReport`), same stamp, same
 * purity rule -- only the address is different.
 *
 * IT REPORTS THE HORIZON BEFORE IT REPORTS A NUMBER, and every metric's, not
 * just the coloured one. A pasted `turns: 4,102 over 31 active days` read in a
 * message six weeks later is a claim about a YEAR unless the line beside it says
 * the source only keeps thirty days. That sentence is the difference between a
 * measurement and a boast.
 */

import type { ActivityMatrix } from '@shared/activity-matrix'
import { formatActivityCount, formatHorizon } from './activity-values'
import { reportChild, reportRow, type WallReportView, wallReport } from './report'

export function activityReport(matrix: ActivityMatrix | null, view: WallReportView): string {
  const days = matrix?.days ?? []
  const span = days.length > 0 ? `${days[0].day} .. ${days[days.length - 1].day}` : null
  return wallReport({
    title: 'ACTIVITY',
    code: 'A9',
    ...view,
    lines: [
      // The zone is part of the claim: the same turns bucket onto different days
      // in Bangkok and in UTC, so a report that did not name one would be
      // unreadable by anybody who was not sitting where it was taken.
      matrix ? reportRow(`${days.length} days`, span, `bucketed in ${matrix.tz}`) : null,
      ...(matrix?.metrics ?? []).map(series => [
        reportRow(
          `${series.label}:`,
          formatActivityCount(series.total, series.unit),
          `over ${series.activeDays} active day${series.activeDays === 1 ? '' : 's'}`,
          `peak ${formatActivityCount(series.max, series.unit)}`,
        ),
        reportChild(formatHorizon(series.horizon)),
      ]),
    ],
    empty: 'the activity feed never arrived',
  })
}
