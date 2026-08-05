// Human-friendly rendering of rate-limit facts: the "resets in ..." countdown and the bucket
// name. Shared rather than web-only because the transcript event describers (which are pure,
// see system-events/) format the same rate_limit entry the control panel does.
//
// Human-friendly "resets in ..." rendering for rate-limit resetsAt timestamps.
//
//   < 1 hour  -> "resets in 42m"
//   < 24 hours -> "resets in 2h"  (hours rounded UP when minute remainder >= 45)
//   >= 24 hours -> "resets in 7d 2h" (same rounding; "0h" suffix suppressed)
//
// resetsAt: epoch ms (CC's rate_limit_info.resetsAt is seconds; callers must
// normalize before passing in).

export function formatResetIn(resetsAt: number | undefined, now: number = Date.now()): string | undefined {
  if (!resetsAt) return undefined
  const deltaMs = resetsAt - now
  if (deltaMs <= 0) return 'resets now'

  const totalMinutes = Math.floor(deltaMs / 60_000)

  if (totalMinutes < 60) return `resets in ${totalMinutes}m`

  // Round hours UP when remainder >= 45 minutes.
  const totalHoursRaw = totalMinutes / 60
  const totalHours = totalMinutes % 60 >= 45 ? Math.ceil(totalHoursRaw) : Math.floor(totalHoursRaw)

  if (totalHours < 24) return `resets in ${totalHours}h`

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours === 0 ? `resets in ${days}d` : `resets in ${days}d ${hours}h`
}

/** CC's rate-limit bucket id -> a name a human reads ("five_hour" -> "5-hour"). */
export function formatRateBucketName(type: string | undefined): string {
  if (!type) return 'API'
  const map: Record<string, string> = {
    seven_day: '7-day',
    five_hour: '5-hour',
  }
  return map[type] || type
}
