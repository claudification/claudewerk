/**
 * Structured performance metrics ring buffer.
 * Opt-in via dashboard prefs (showPerfMonitor). When disabled, record() is a no-op.
 */

export type PerfCategory = 'render' | 'grouping' | 'ws' | 'scroll' | 'transcript' | 'other'

export interface PerfEntry {
  t: number // timestamp ms
  category: PerfCategory
  label: string
  durationMs: number
  detail?: string
}

const MAX_ENTRIES = 500
const buffer: PerfEntry[] = []
let enabled = false
const listeners = new Set<() => void>()

export function setPerfEnabled(on: boolean) {
  enabled = on
  if (on) {
    bindVisibilityMarker()
  } else {
    buffer.length = 0
    notify()
  }
}

/**
 * Drop a zero-duration marker into the buffer whenever the tab hides/shows.
 * Without this, a backgrounded tab produces a multi-second gap in the timeline
 * with no explanation -- and every pending rAF flushes on resume as a phantom
 * "stall". The marker makes the cause legible at a glance (visible in the full
 * HUD list; the `suspended` tag on the affected commit->paint entries is the
 * signal that survives the significant-only report filter). Bound once, lazily,
 * the first time the monitor is enabled; record() no-ops while disabled.
 */
let visibilityMarkerBound = false
function bindVisibilityMarker() {
  if (visibilityMarkerBound || typeof document === 'undefined') return
  visibilityMarkerBound = true
  document.addEventListener('visibilitychange', () => {
    record('other', 'visibility', 0, document.hidden ? 'hidden (rAF paused)' : 'visible')
  })
}

export function isPerfEnabled(): boolean {
  return enabled
}

export function record(category: PerfCategory, label: string, durationMs: number, detail?: string) {
  if (!enabled) return
  buffer.push({ t: Date.now(), category, label, durationMs, detail })
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
  notify()
}

export function getEntries(): readonly PerfEntry[] {
  return buffer
}

export function clearEntries() {
  buffer.length = 0
  notify()
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) fn()
}

/** Format duration with color hint for the UI */
export function durationColor(ms: number): string {
  if (ms < 5) return 'text-emerald-400'
  if (ms < 16) return 'text-muted-foreground'
  if (ms < 50) return 'text-amber-400'
  return 'text-red-400'
}

/**
 * Summary stats for a category. Excludes rAF-suspension artifacts (commit->paint
 * entries tagged `suspended` while the tab was hidden) -- their gap is wall-clock
 * idle time, not main-thread cost, and would otherwise poison Max/P95 with phantom
 * multi-second "stalls". The raw entries stay in the buffer + entry list; only the
 * aggregate ignores them.
 */
export function categoryStats(cat: PerfCategory): { count: number; avg: number; max: number; p95: number } {
  const entries = buffer.filter(e => e.category === cat && !e.detail?.includes('suspended'))
  if (entries.length === 0) return { count: 0, avg: 0, max: 0, p95: 0 }
  const durations = entries.map(e => e.durationMs).sort((a, b) => a - b)
  const sum = durations.reduce((a, b) => a + b, 0)
  return {
    count: entries.length,
    avg: sum / entries.length,
    max: durations[durations.length - 1],
    p95: durations[Math.floor(durations.length * 0.95)],
  }
}
