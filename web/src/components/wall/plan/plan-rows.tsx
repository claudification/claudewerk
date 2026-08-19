/**
 * The rows under the S2 chart: what each profile is doing RIGHT NOW.
 *
 * Two rules this file exists to keep:
 *
 *  - A STALE READING NEVER RENDERS AS A BARE NUMBER. The windows are real but as
 *    of `polledAt`, so the age goes next to the percentage every time. A
 *    carried-forward 62% shown as "62%" is a lie about how much room is left.
 *  - NO BARE TIMES. A reset renders as relative + viewer-local clock + the zone
 *    it is in, per the scheduled-tasks rule, because the broker runs in UTC and
 *    the person reading does not.
 */

import { formatResetIn } from '@shared/format-reset-time'
import { formatAbsolute, formatRelative, viewerTimeZone } from '@shared/format-when'
import { WALL_PLAN_THROTTLE_PCT } from '@shared/wall-plan-series'
import { useRelativeTime } from '@/hooks/use-relative-time'
import type { PlanLine } from './plan-model'

const STATE_LABEL: Record<string, string> = {
  unauthed: 'not authed',
  unknown: 'no 5h window',
}

function errorLabel(kind: string | undefined): string {
  if (kind === 'no_token') return 'no token'
  if (kind === 'http') return 'probe rejected'
  if (kind === 'network') return 'probe unreachable'
  if (kind === 'parse') return 'probe unreadable'
  return 'probe failed'
}

/** "resets in 2h -- Wed 19 Aug, 18:00 Europe/Berlin". */
function PlanReset({ resetsAt }: { resetsAt: number | undefined }) {
  // Subscribes this row to the app's single 30s tick so the countdown moves.
  // The string rendered is the rate-limit house style from `format-reset-time`,
  // which is tighter than this hook's own wording in a 240px column.
  useRelativeTime(resetsAt)
  if (!resetsAt) return null

  const tz = viewerTimeZone()
  const now = Date.now()
  return (
    <span className="wall-plan-reset">
      <b>{formatResetIn(resetsAt, now)}</b>
      <span className="wall-plan-when">
        {formatAbsolute(resetsAt, tz, now)} {tz}
      </span>
    </span>
  )
}

/** "62% -- 40m old". Never the number on its own. */
function PlanStaleAge({ polledAt }: { polledAt: number | undefined }) {
  useRelativeTime(polledAt)
  if (!polledAt) return <span className="wall-plan-stale">carried forward</span>
  return <span className="wall-plan-stale">{formatRelative(polledAt, Date.now())}</span>
}

function PlanRow({ line }: { line: PlanLine }) {
  const { latest } = line
  const live = latest.state === 'ok'
  const over = live && latest.utilization >= WALL_PLAN_THROTTLE_PCT

  return (
    <li
      className="wall-plan-row"
      data-profile={line.key}
      data-state={latest.state}
      {...(over ? { 'data-over': '' } : {})}
      {...(latest.stale ? { 'data-stale': '' } : {})}
    >
      <span className="wall-plan-swatch" style={{ background: line.color }} aria-hidden="true" />
      <span className="wall-plan-name">{line.profile}</span>
      {line.node && <span className="wall-plan-host">{line.node}</span>}
      <span className="wall-plan-pct">
        {live ? `${Math.round(latest.utilization)}%` : (STATE_LABEL[latest.state] ?? errorLabel(latest.errorKind))}
      </span>

      {live && (
        <div className="wall-plan-bar" role="presentation">
          <i style={{ width: `${Math.max(1, Math.min(100, latest.utilization))}%`, background: line.color }} />
        </div>
      )}

      <span className="wall-plan-foot">
        {latest.stale && <PlanStaleAge polledAt={latest.polledAt} />}
        <PlanReset resetsAt={latest.resetsAt} />
      </span>
    </li>
  )
}

export function PlanRows({ lines }: { lines: readonly PlanLine[] }) {
  return (
    <ul className="wall-plan-rows">
      {lines.map(line => (
        <PlanRow key={line.key} line={line} />
      ))}
    </ul>
  )
}
