/**
 * ONE ACTIVITY MATRIX, for whichever rig needs it.
 *
 * Both shared HTTP fixtures answer A9 -- `wall-feed-stubs` for the resilience
 * suites (thinnest legal body) and `wall-crosspane-feed` for the filter and
 * rewind proofs (data-bearing). "Thinnest legal" is NOT `[]` here: the pane
 * counts days off the response, and a matrix with no days renders as a pane that
 * has landed a feed and has nothing in it -- which every cross-pane suite reads
 * as a pane that failed to load.
 *
 * So both get a real axis, and it is built here once. The two fixtures stay
 * separate files for the reason `wall-feed-stubs` states in its own header; what
 * they share is the SHAPE, and a second hand-written copy of it is a second
 * thing to update the next time the contract moves.
 */

import type { ActivityCell, ActivityMatrix, ActivityMetricSeries } from '@shared/activity-matrix'

/** Days on the fixture axis. Wide enough that a 30-day horizon leaves most of it
 *  `unavailable`, which is the case worth having in a rig. */
const FIXTURE_DAYS = 70

// KEPT SEPARATE FROM `localDayKey` ON PURPOSE, though fallow reads the two as a
// clone: this is the RIG's own calendar. Importing the production formatter would
// make a bug in it wrong on both sides of every A9 assertion at once, and the
// suites that pin day bucketing would go green on it. Four lines is a cheap price
// for an independent witness.
// fallow-ignore-next-line code-duplication
function isoDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fold(
  metric: ActivityMetricSeries['metric'],
  label: string,
  unit: ActivityMetricSeries['unit'],
  cells: ActivityCell[],
  horizon: ActivityMetricSeries['horizon'],
): ActivityMetricSeries {
  const values = cells.filter(c => c.state === 'active').map(c => c.value ?? 0)
  return {
    metric,
    label,
    unit,
    horizon,
    cells,
    max: values.length ? Math.max(...values) : 0,
    total: values.reduce((a, b) => a + b, 0),
    activeDays: values.length,
  }
}

/**
 * A matrix ending TODAY, as of `now`.
 *
 * Every third day is active, so a grid has all three states in it: `active`,
 * `empty` (the days between) and `unavailable` (everything past each metric's
 * own floor). The 30-day metrics carry a floor at day 40 of 70 and the commit
 * ledger reaches the whole axis, exactly as production does.
 */
export function activityMatrixFixture(now: number): ActivityMatrix {
  const days = Array.from({ length: FIXTURE_DAYS }, (_, i) => {
    const ms = now - (FIXTURE_DAYS - 1 - i) * 86_400_000
    return { day: isoDay(ms), dow: new Date(ms).getDay() }
  })

  const cells = (floor: number, every: number, value: (i: number) => number): ActivityCell[] =>
    days.map((_, i) => {
      if (i < floor) return { state: 'unavailable' }
      return i % every === 0 ? { state: 'active', value: value(i) } : { state: 'empty' }
    })

  const retention = (n: number): ActivityMetricSeries['horizon'] => ({
    kind: 'retention',
    retentionDays: n,
    sinceDay: days[FIXTURE_DAYS - n]?.day,
    note: `pruned at ${n} days`,
  })

  return {
    tz: 'Asia/Bangkok',
    generatedAt: now,
    defaultMetric: 'commits',
    days,
    metrics: [
      fold(
        'commits',
        'Commits',
        'count',
        cells(0, 3, i => i + 1),
        {
          kind: 'coverage',
          sinceDay: days[0].day,
          note: 'the ledger began at hook install',
        },
      ),
      fold(
        'cardsClosed',
        'Cards closed',
        'count',
        cells(0, 5, () => 2),
        retention(90),
      ),
      fold(
        'turns',
        'Turns',
        'count',
        cells(40, 2, i => i * 3),
        retention(30),
      ),
      fold(
        'tokens',
        'Tokens',
        'tokens',
        cells(40, 2, i => i * 90_000),
        retention(30),
      ),
      fold(
        'usd',
        'USD',
        'usd',
        cells(40, 2, i => i / 2).map(cell =>
          cell.state === 'active'
            ? {
                ...cell,
                usd: { provenance: 'mixed', exactUsd: (cell.value ?? 0) / 2, estimatedUsd: (cell.value ?? 0) / 2 },
              }
            : cell,
        ),
        retention(30),
      ),
    ],
  }
}
