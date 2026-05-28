/**
 * Small formatters for the sheaf page.
 */

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

export function formatCost(amount: number, estimated: boolean): string {
  const tilde = estimated ? '~' : ''
  if (amount >= 100) return `${tilde}$${amount.toFixed(0)}`
  if (amount >= 10) return `${tilde}$${amount.toFixed(2)}`
  return `${tilde}$${amount.toFixed(2)}`
}

/**
 * Cost-heat color: brighter/hotter as spend climbs, so the eye lands on the
 * expensive buckets. Static Tailwind classes (purge-safe -- no interpolation).
 * Thresholds are USD; tune against real fleet numbers.
 */
export function costHeatClass(amount: number): string {
  if (amount >= 20) return 'text-rose-400'
  if (amount >= 5) return 'text-amber-400'
  if (amount >= 1) return 'text-emerald-400'
  return 'text-muted-foreground'
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
  const days = Math.floor(hr / 24)
  const remHr = hr % 24
  return remHr > 0 ? `${days}d ${remHr}h` : `${days}d`
}

export function formatClockTime(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${month}-${day} ${formatClockTime(ts)}`
}

/** Compact "X ago" for a window-bounded relative time. */
export function formatAgo(deltaMs: number): string {
  if (deltaMs < 60_000) return `${Math.max(1, Math.floor(deltaMs / 1000))}s ago`
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)}h ago`
  return `${Math.floor(deltaMs / 86_400_000)}d ago`
}
