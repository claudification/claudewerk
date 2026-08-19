/**
 * S2's shape work, with no React in it.
 *
 * Turning a flat list of samples into "one line per profile, and a row saying
 * what that profile is doing right now" is the part that can be wrong in ways a
 * screenshot will not show, so it lives here and is tested directly.
 *
 * THE LINE ONLY EVER CONNECTS REAL SAMPLES. A path is cut whenever the series
 * stops being a live reading -- a 429, a logged-out profile, or simply a hole in
 * time where nothing was recorded. Bridging those would draw a confident
 * straight line across an hour nobody measured, which is precisely the number a
 * throttle chart must not invent.
 */

import type { WallPlanSample } from '@shared/wall'
import { WALL_PLAN_MIN_GAP_MS, wallPlanKey } from '@shared/wall-plan-series'

/** Longer than this between two consecutive readings and the line breaks
 *  instead of spanning the hole. Four sampling intervals: long enough that a
 *  quiet fleet still draws a continuous line, short enough that an outage is
 *  visible as one. */
export const PLAN_GAP_BREAK_MS = WALL_PLAN_MIN_GAP_MS * 4

export interface PlanPoint {
  at: number
  utilization: number
}

export interface PlanLine {
  /** `wallPlanKey` -- stable across renders, so it is the React key too. */
  key: string
  profile: string
  node?: string
  /** Unbroken runs of live readings, oldest first. */
  segments: PlanPoint[][]
  /** The newest sample of ANY state. What the row under the chart renders. */
  latest: WallPlanSample
  /** Assigned by KEY, never by position: the rows re-sort as utilization moves,
   *  and a line that changed colour when a profile overtook another would be
   *  unreadable. */
  color: string
}

/** Split one profile's samples into unbroken runs of live readings. */
function segmentsOf(samples: readonly WallPlanSample[]): PlanPoint[][] {
  const segments: PlanPoint[][] = []
  let current: PlanPoint[] = []

  for (const sample of samples) {
    const previous = current[current.length - 1]
    const broken = sample.state !== 'ok' || (previous !== undefined && sample.at - previous.at > PLAN_GAP_BREAK_MS)
    if (broken && current.length > 0) {
      segments.push(current)
      current = []
    }
    if (sample.state === 'ok') current.push({ at: sample.at, utilization: sample.utilization })
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * Group samples into one line per profile@node.
 *
 * Ordered WORST FIRST -- the pane exists to answer "which account gets throttled
 * first", so the answer is the top row and never something you scroll to. A
 * profile with no live reading sorts below every one that has one, since "no
 * telemetry" is not a claim about being close to the limit.
 */
export function buildPlanLines(samples: readonly WallPlanSample[]): PlanLine[] {
  const grouped = new Map<string, WallPlanSample[]>()
  for (const sample of samples) {
    const key = wallPlanKey(sample)
    const existing = grouped.get(key)
    if (existing) existing.push(sample)
    else grouped.set(key, [sample])
  }

  const lines: PlanLine[] = []
  const byKey = [...grouped.keys()].sort()
  for (const [key, group] of grouped) {
    const ordered = [...group].sort((a, b) => a.at - b.at)
    const latest = ordered[ordered.length - 1]
    if (!latest) continue
    lines.push({
      key,
      profile: latest.profile,
      ...(latest.node ? { node: latest.node } : {}),
      segments: segmentsOf(ordered),
      latest,
      color: planLineColor(byKey.indexOf(key)),
    })
  }

  return lines.sort((a, b) => {
    const aRank = a.latest.state === 'ok' ? a.latest.utilization : -1
    const bRank = b.latest.state === 'ok' ? b.latest.utilization : -1
    return bRank - aRank || a.key.localeCompare(b.key)
  })
}

/** The chart's own coordinate space. `preserveAspectRatio="none"` stretches it
 *  to whatever width the column gives, and the strokes opt out of that scaling
 *  so a narrow pane does not get fat lines. */
export const PLAN_VIEWBOX = { width: 1000, height: 100 } as const

export interface PlanDomain {
  from: number
  to: number
}

/** One SVG path per unbroken run. A single-sample run becomes a 1px dash rather
 *  than vanishing -- one real reading is still something the chart should show. */
export function planPath(segments: readonly PlanPoint[][], domain: PlanDomain): string {
  const span = Math.max(1, domain.to - domain.from)
  const x = (at: number): number => ((at - domain.from) / span) * PLAN_VIEWBOX.width
  const y = (pct: number): number => PLAN_VIEWBOX.height - (Math.max(0, Math.min(100, pct)) / 100) * PLAN_VIEWBOX.height

  const parts: string[] = []
  for (const segment of segments) {
    const points = segment.map(p => `${x(p.at).toFixed(2)} ${y(p.utilization).toFixed(2)}`)
    if (points.length === 0) continue
    if (points.length === 1) {
      parts.push(`M${points[0]} l0.6 0`)
      continue
    }
    parts.push(
      `M${points[0]} ${points
        .slice(1)
        .map(p => `L${p}`)
        .join(' ')}`,
    )
  }
  return parts.join(' ')
}

/** y in view units for a horizontal rule at `pct`. */
export function planRuleY(pct: number): number {
  return PLAN_VIEWBOX.height - (pct / 100) * PLAN_VIEWBOX.height
}

/** How many distinct `--chart-N` tokens the app's palette has. */
const CHART_TOKENS = 5

/** The app's chart palette, indexed. Wraps past five: six profiles means two
 *  share a hue, which the host label beside the name disambiguates. */
function planLineColor(index: number): string {
  return `var(--chart-${(index % CHART_TOKENS) + 1})`
}
