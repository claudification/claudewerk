// Logs every JS/CSS chunk fetch the browser performs into console.debug,
// where debug-log captures it for the in-app DebugConsole. PerformanceObserver
// with `buffered: true` replays the initial bundle's resource entries too, so
// chunks that loaded before this code ran still show up.
//
// Each line carries the full phase breakdown (see resource-timing.ts) because
// the previous version logged only a total, which cannot distinguish a chunk
// queued behind a busy service worker from a chunk that was genuinely slow to
// download. A SUMMARY line lands once the load settles, and the raw rows stay
// available on `window.__chunkReport()` for pulling over remote-control.

import { formatPhases, formatSummary, phasesOf, type ResourcePhases, summarize } from './resource-timing'

const ASSET_RE = /\/assets\/[^/]+\.(js|css|mjs)(?:\?|$)/
/** Emit the summary once this long passes with no new asset arriving. */
const SETTLE_MS = 1500

const rows: ResourcePhases[] = []
let firstStart = Number.POSITIVE_INFINITY
let lastEnd = 0
let settleTimer: ReturnType<typeof setTimeout> | null = null
let installed = false

async function probeCacheSize(url: string): Promise<number> {
  try {
    if (typeof caches === 'undefined') return 0
    const resp = await caches.match(url)
    if (!resp) return 0
    const blob = await resp.clone().blob()
    return blob.size
  } catch {
    return 0
  }
}

function scheduleSummary() {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    if (rows.length === 0) return
    console.debug(formatSummary(summarize(rows, lastEnd - firstStart)))
  }, SETTLE_MS)
}

async function logEntry(entry: PerformanceResourceTiming) {
  if (!ASSET_RE.test(entry.name)) return

  const phases = phasesOf(entry)

  // A service worker serving from the Cache API reports opaque sizes. Probe the
  // cache so the byte columns stay meaningful instead of reading as zero.
  if (phases.transferSize === 0 && phases.decodedSize === 0 && entry.workerStart > 0) {
    phases.decodedSize = await probeCacheSize(entry.name)
  }

  rows.push(phases)
  firstStart = Math.min(firstStart, entry.startTime)
  lastEnd = Math.max(lastEnd, entry.responseEnd || entry.startTime + entry.duration)

  console.debug(formatPhases(phases))
  scheduleSummary()
}

/** Every asset row recorded so far. Reachable as `window.__chunkReport()`. */
function chunkReport(): { rows: ResourcePhases[]; summary: ReturnType<typeof summarize> } {
  return { rows: [...rows], summary: summarize(rows, lastEnd - firstStart) }
}

export function installChunkLoadLog() {
  if (installed || typeof PerformanceObserver === 'undefined') return
  installed = true

  ;(window as unknown as { __chunkReport: typeof chunkReport }).__chunkReport = chunkReport

  try {
    const obs = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        logEntry(entry as PerformanceResourceTiming)
      }
    })
    // `buffered: true` replays already-recorded entries (the initial bundle).
    obs.observe({ type: 'resource', buffered: true })
  } catch {
    // PerformanceObserver missing options support -- non-fatal, just skip.
  }
}
