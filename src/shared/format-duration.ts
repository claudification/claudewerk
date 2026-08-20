/**
 * Compact human-readable duration: `45s`, `12m`, `3h 20m`. For at-a-glance
 * "age" / "idle" readouts (status age, last-input age, conversation age).
 *
 * `clampNegative` (default `true`) floors the span at zero, so a clock-skewed
 * negative reads `0s`. Pass `false` to let the negative through -- the ladder
 * then renders it as a raw second count (`-5s`), which is what `formatAge` in
 * the web client has always shown for a future timestamp. Keeping the skew
 * visible is the point there: a silent `0s` looks like "just now".
 */
export function formatDuration(ms: number, opts: { clampNegative?: boolean } = {}): string {
  const { clampNegative = true } = opts
  const seconds = Math.floor((clampNegative ? Math.max(0, ms) : ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
