/**
 * resource-timing - turn a PerformanceResourceTiming into the phase breakdown
 * that actually tells you WHERE a slow asset spent its time.
 *
 * A single `duration` number is useless for diagnosis: a chunk reported as
 * "3750ms" can be 3700ms sitting in a service-worker queue plus 50ms of actual
 * transfer, or 3700ms of download on a bad link. Those have opposite fixes. The
 * phases below separate them.
 *
 * Zeroed fields are NOT zero-duration -- they are "not available" (cross-origin
 * without Timing-Allow-Origin, or a service-worker response where the network
 * fields never happened). Every span returns null rather than 0 in that case, so
 * a missing measurement can never masquerade as a fast one.
 */

export interface ResourcePhases {
  file: string
  /** Wall time from fetch queued to last byte. */
  total: number
  /** Time the request spent inside the service worker before it hit the network. */
  sw: number | null
  /** DNS + TCP + TLS. Null when the connection was reused. */
  connect: number | null
  /** Time to first byte, measured from request sent. */
  wait: number | null
  /** Response body transfer. */
  download: number | null
  /** Time unaccounted for by the phases above -- queueing and thread contention. */
  stall: number
  /** Bytes over the wire, including headers. 0 when served from a cache. */
  transferSize: number
  /** Bytes after decompression. */
  decodedSize: number
  /** h2, h3, http/1.1, or '' when a service worker answered. */
  protocol: string
  servedBy: 'network' | 'service-worker' | 'memory-or-disk-cache'
}

/** A span is only real when both endpoints were recorded and move forward. */
function span(from: number, to: number): number | null {
  if (!from || !to || to < from) return null
  return to - from
}

function classify(entry: PerformanceResourceTiming): ResourcePhases['servedBy'] {
  if (entry.workerStart > 0) return 'service-worker'
  if (entry.transferSize === 0 && entry.decodedBodySize > 0) return 'memory-or-disk-cache'
  return 'network'
}

export function phasesOf(entry: PerformanceResourceTiming): ResourcePhases {
  const file = entry.name.split('/').pop()?.split('?')[0] || entry.name
  const total = entry.duration

  const sw = entry.workerStart > 0 ? span(entry.workerStart, entry.fetchStart) : null
  const connect = span(entry.domainLookupStart, entry.connectEnd)
  const wait = span(entry.requestStart, entry.responseStart)
  const download = span(entry.responseStart, entry.responseEnd)

  const accounted = (sw ?? 0) + (connect ?? 0) + (wait ?? 0) + (download ?? 0)

  return {
    file,
    total,
    sw,
    connect,
    wait,
    download,
    stall: Math.max(0, total - accounted),
    transferSize: entry.transferSize,
    decodedSize: entry.decodedBodySize,
    protocol: entry.nextHopProtocol,
    servedBy: classify(entry),
  }
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`
}

/** `1.0MB` for readability once a number stops fitting in the head. */
function humanBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}MB` : kb(bytes)
}

/** Compression ratio, or null when there is nothing to compare against. */
export function compressionRatio(p: ResourcePhases): number | null {
  if (!p.transferSize || !p.decodedSize) return null
  return p.decodedSize / p.transferSize
}

const SERVED_BY_TAG: Record<ResourcePhases['servedBy'], string> = {
  network: '',
  'service-worker': ' via=sw',
  'memory-or-disk-cache': ' via=cache',
}

function ms(label: string, value: number | null): string {
  return value === null ? '' : ` ${label}=${Math.round(value)}`
}

/**
 * One line per asset. Phases that did not happen are omitted rather than
 * printed as zero, so the line only ever shows measurements that are real.
 */
export function formatPhases(p: ResourcePhases): string {
  const ratio = compressionRatio(p)
  const sizePart = p.transferSize > 0 ? humanBytes(p.transferSize) : `${humanBytes(p.decodedSize)} (cached)`
  const comp = ratio === null ? '' : ratio > 1.05 ? ` gz=${ratio.toFixed(1)}x` : ' UNCOMPRESSED'
  const proto = p.protocol ? ` ${p.protocol}` : ''

  return (
    `[chunk] ${p.file} ${sizePart}${comp}${proto}${SERVED_BY_TAG[p.servedBy]}` +
    ` total=${Math.round(p.total)}` +
    ms('sw', p.sw) +
    ms('conn', p.connect) +
    ms('ttfb', p.wait) +
    ms('dl', p.download) +
    (p.stall >= 1 ? ` stall=${Math.round(p.stall)}` : '')
  )
}

export interface LoadSummary {
  count: number
  wallMs: number
  transferBytes: number
  decodedBytes: number
  uncompressed: number
  viaServiceWorker: number
  worstStall: ResourcePhases | null
}

export function summarize(rows: ResourcePhases[], wallMs: number): LoadSummary {
  let transferBytes = 0
  let decodedBytes = 0
  let uncompressed = 0
  let viaServiceWorker = 0
  let worstStall: ResourcePhases | null = null

  for (const r of rows) {
    transferBytes += r.transferSize
    decodedBytes += r.decodedSize
    const ratio = compressionRatio(r)
    if (ratio !== null && ratio <= 1.05) uncompressed++
    if (r.servedBy === 'service-worker') viaServiceWorker++
    if (!worstStall || r.stall > worstStall.stall) worstStall = r
  }

  return { count: rows.length, wallMs, transferBytes, decodedBytes, uncompressed, viaServiceWorker, worstStall }
}

export function formatSummary(s: LoadSummary): string {
  const worst =
    s.worstStall && s.worstStall.stall >= 1
      ? ` worst-stall=${s.worstStall.file}@${Math.round(s.worstStall.stall)}ms`
      : ''
  return (
    `[chunk] SUMMARY ${s.count} assets in ${Math.round(s.wallMs)}ms -- ` +
    `wire=${humanBytes(s.transferBytes)} decoded=${humanBytes(s.decodedBytes)} ` +
    `uncompressed=${s.uncompressed}/${s.count} via-sw=${s.viaServiceWorker}${worst}`
  )
}
