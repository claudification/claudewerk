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

/**
 * Precise turn-timing duration: `842ms`, `1.5s`, `2m30s`. For the turn/step
 * summaries an agent host emits and the transcript renders, where sub-second
 * resolution is the point. A DIFFERENT contract from `formatDuration` above --
 * that one is an at-a-glance age readout, this one is a measurement.
 *
 * Behaviour is preserved verbatim from the three copies it replaces
 * (acp translator, opencode ndjson-parser, web group-view-types), warts and
 * all: 59_999 renders `60.0s`, 119_500 renders `1m60s`, and negatives fall
 * through the `<1000` branch as raw `-5000ms`. Callers only ever pass real
 * elapsed spans, so those edges are unreachable in practice -- but they are
 * pinned by tests so a future "cleanup" is a red test, not a silent re-render.
 */
export function formatDurationPrecise(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s % 60)}s`
}
