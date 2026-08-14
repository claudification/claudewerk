/**
 * Timed JSON fetches -- the `net` perf category.
 *
 * A slow data load has three candidate owners and they need different fixes:
 * the SERVER (query cost), the WIRE (payload size / transfer), or the CLIENT
 * (parse + apply). Without a split, all three read as "loading is slow" and the
 * guess is usually wrong -- broker SQL for these routes measures single-digit ms
 * while the payloads run into hundreds of KB.
 *
 * Every sample carries all three so they can never be confused again:
 *   `transcript.cold 214ms wait=181 parse=8 88.2KB srv=6.4ms`
 *     wait  -- request start to headers+body available (server + transfer)
 *     parse -- JSON.parse of the body text (client)
 *     srv   -- the broker's own `Server-Timing` total, when the response
 *              carries one. Absent means the broker did not report it, NOT
 *              that server time was zero.
 */

import { isPerfEnabled, record } from './perf-metrics'

/** Total of every `dur=` in a `Server-Timing` header, in ms, or undefined. */
export function parseServerTiming(header: string | null): number | undefined {
  if (!header) return undefined
  let total: number | undefined
  for (const match of header.matchAll(/dur\s*=\s*([\d.]+)/g)) {
    const value = Number.parseFloat(match[1])
    if (Number.isFinite(value)) total = (total ?? 0) + value
  }
  return total
}

/** Internal: the measured shape a completed fetch is formatted from. */
interface TimedJson<T> {
  data: T
  /** Decoded body size in characters (JSON text length). */
  bytes: number
  /** Request start to body-in-hand: server work + transfer. */
  waitMs: number
  /** Client-side `JSON.parse` cost. */
  parseMs: number
  serverMs?: number
}

function formatDetail<T>(r: TimedJson<T>): string {
  const kb = (r.bytes / 1024).toFixed(1)
  const srv = r.serverMs !== undefined ? ` srv=${r.serverMs.toFixed(1)}ms` : ''
  return `wait=${r.waitMs.toFixed(0)} parse=${r.parseMs.toFixed(1)} ${kb}KB${srv}`
}

/**
 * `fetch` + JSON parse, recorded as one `net` sample.
 *
 * Returns null on a non-OK response, a parse failure, or an aborted/failed
 * request -- matching what every data-loading call site here already does with a
 * bare fetch, so adopting it never changes behaviour. Reads the body as TEXT so
 * the payload size is measured rather than guessed from `content-length` (which
 * reports COMPRESSED bytes, and is absent on chunked responses).
 */
export async function fetchJsonTimed<T>(label: string, url: string, init?: RequestInit): Promise<T | null> {
  const timed = isPerfEnabled()
  const t0 = timed ? performance.now() : 0
  try {
    const res = await fetch(url, init)
    if (!res.ok) return null
    const text = await res.text()
    const waitMs = timed ? performance.now() - t0 : 0
    const p0 = timed ? performance.now() : 0
    const data = JSON.parse(text) as T
    if (timed) {
      const result: TimedJson<T> = {
        data,
        bytes: text.length,
        waitMs,
        parseMs: performance.now() - p0,
        serverMs: parseServerTiming(res.headers.get('server-timing')),
      }
      record('net', label, result.waitMs + result.parseMs, formatDetail(result))
    }
    return data
  } catch {
    if (timed) record('net', `${label}.failed`, performance.now() - t0)
    return null
  }
}
