/** Reset-window formatting for the usage popover. */

// fallow-ignore-next-line complexity
export function formatReset(resetAt: string): string {
  const ms = new Date(resetAt).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

export function formatResetAbsolute(resetAt: string): string {
  const dt = new Date(resetAt)
  const day = dt.toLocaleDateString(undefined, { weekday: 'short' })
  const time = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} ${time}`
}

/** Extra-usage credits reset on the 1st of the following month. */
export function getMonthlyResetDate(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth() + 1, 1)
}
