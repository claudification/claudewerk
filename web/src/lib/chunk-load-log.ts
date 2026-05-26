// Logs every JS/CSS chunk fetch the browser performs into console.debug,
// where debug-log captures it for the in-app DebugConsole. PerformanceObserver
// with `buffered: true` replays the initial bundle's resource entries too, so
// chunks that loaded before this code ran still show up.

const ASSET_RE = /\/assets\/[^/]+\.(js|css|mjs)(?:\?|$)/

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

async function logEntry(entry: PerformanceResourceTiming) {
  if (!ASSET_RE.test(entry.name)) return
  const file = entry.name.split('/').pop()?.split('?')[0] || entry.name
  let size = entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0
  let tag = ''
  if (entry.transferSize === 0 && entry.decodedBodySize > 0) {
    tag = ' (cache)'
  } else if (size === 0 && entry.workerStart > 0) {
    // Service worker served from Cache API -- timing fields are opaque. Probe the cache.
    size = await probeCacheSize(entry.name)
    tag = ' (sw cache)'
  }
  const sizeStr = size > 0 ? `${(size / 1024).toFixed(1)}KB` : '?KB'
  const duration = Math.round(entry.duration)
  console.debug(`[chunk] ${file} ${sizeStr} ${duration}ms${tag}`)
}

let installed = false

export function installChunkLoadLog() {
  if (installed || typeof PerformanceObserver === 'undefined') return
  installed = true
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
