/**
 * Structured performance metrics ring buffer.
 * Opt-in via dashboard prefs (showPerfMonitor). When disabled, record() is a no-op.
 */

import { currentMessageTag } from './perf-message-context'

export type PerfCategory = 'render' | 'grouping' | 'ws' | 'scroll' | 'transcript' | 'message' | 'other'

export interface PerfEntry {
  t: number // timestamp ms
  category: PerfCategory
  label: string
  durationMs: number
  detail?: string
  // Wire-message (or flush-batch) this cost is attributed to, when known.
  // Stamped from perf-message-context at record() time -- see that module.
  msgType?: string
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
  buffer.push({ t: Date.now(), category, label, durationMs, detail, msgType: currentMessageTag() })
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
  notify()
}

/**
 * List re-render tally. Counts how many conversation-list leaves render within
 * a single animation frame and flushes ONE aggregate per frame -- as a buffer
 * entry (category 'other', so it never pollutes the 'render' stats) AND a
 * `[list-churn]` console.debug line so it shows up in the captured perf report
 * timeline even though it carries no duration.
 *
 * Purpose: tell apart the two list-perf hypotheses on a "heavy even when idle"
 * capture. A memo leak shows MANY rows re-rendering per store mutation; Zustand
 * selector churn shows the store notifying constantly while rows stay near zero
 * (the per-set() selector evaluation cost is invisible to React.Profiler, so
 * "rows quiet but it still feels heavy" is itself the diagnostic signal --
 * pair it with `[sync]`/`ws` frequency in the same report).
 *
 * Near-zero overhead when the perf monitor is off: tallyListRender() returns on
 * the first line before touching any counter.
 */
let rowRenders = 0
let groupRenders = 0
let listTallyScheduled = false

export function tallyListRender(kind: 'row' | 'group') {
  if (!enabled) return
  if (kind === 'row') rowRenders++
  else groupRenders++
  if (listTallyScheduled) return
  listTallyScheduled = true
  const flush = () => {
    listTallyScheduled = false
    const rows = rowRenders
    const groups = groupRenders
    rowRenders = 0
    groupRenders = 0
    if (rows === 0 && groups === 0) return
    record('other', 'list.rerender', 0, `rows=${rows} groups=${groups}`)
    console.debug(`[list-churn] rows=${rows} groups=${groups} (this frame)`)
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
  else queueMicrotask(flush)
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
