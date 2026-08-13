/** Shared severity ramp for every usage surface (chip, bars, popover border).
 *  One place decides what "50% is fine, 90% is on fire" looks like. */

export function usageColor(pct: number): string {
  if (pct < 50) return 'bg-emerald-500'
  if (pct < 75) return 'bg-amber-500'
  if (pct < 90) return 'bg-orange-500'
  return 'bg-red-500'
}

export function usageTextColor(pct: number): string {
  if (pct < 50) return 'text-emerald-400'
  if (pct < 75) return 'text-amber-400'
  if (pct < 90) return 'text-orange-400'
  return 'text-red-400'
}

export function usageBorderColor(pct: number): string {
  if (pct < 50) return 'border-emerald-500/30'
  if (pct < 75) return 'border-amber-500/30'
  if (pct < 90) return 'border-orange-500/30'
  return 'border-red-500/30'
}
