/**
 * Zustand store heap profiler.
 *
 * Walks the live store state and estimates retained bytes per top-level slice
 * and per-conversation, so we can pinpoint a memory leak (which slice, which
 * conversation, and whether one giant item -- e.g. a base64 image in a `raw`
 * field -- dominates) without a manual Safari heap snapshot.
 *
 * WHY a custom walker and NOT `JSON.stringify(state).length`:
 *   - stringify allocates a second copy of the whole graph. On a multi-GB
 *     store that can OOM the tab. The walker only READS `string.length`, so
 *     cost scales with the NUMBER of nodes, not total bytes -- fast even at
 *     several GB.
 *   - stringify chokes on cycles / functions; the store mixes data + action
 *     closures at the same level. The walker skips functions and guards cycles.
 *
 * Sizes are ESTIMATES (UTF-16: 2 bytes/char + small per-node overhead). They
 * are for RELATIVE attribution ("events for conv X is 80% of the heap"), not
 * exact accounting.
 */

// Soft ceiling on nodes visited in a single measurement, so a pathological
// graph can never freeze the tab. Hitting it flips `truncated`.
const MAX_NODES = 20_000_000

interface WalkCtx {
  seen: WeakSet<object>
  nodes: number
  truncated: boolean
}

function newCtx(): WalkCtx {
  return { seen: new WeakSet(), nodes: 0, truncated: false }
}

/** Byte size of a primitive, or null if `value` is an object to recurse into. */
function primitiveSize(value: unknown, t: string): number | null {
  switch (t) {
    case 'boolean':
      return 4
    case 'number':
      return 8
    case 'bigint':
      return 16
    case 'string':
      return (value as string).length * 2 + 8
    case 'function':
    case 'symbol':
      return 0
    default:
      return null
  }
}

/** Sum retained bytes over any iterable of values (array items / set members). */
function sumValues(items: Iterable<unknown>, ctx: WalkCtx): number {
  let bytes = 0
  for (const v of items) bytes += roughSizeOf(v, ctx)
  return bytes
}

/** Sum retained bytes of an object's own enumerable string-keyed properties. */
function sizeOfOwnProps(obj: object, ctx: WalkCtx): number {
  let bytes = 0
  for (const k in obj) {
    if (!Object.hasOwn(obj, k)) continue
    bytes += k.length * 2 + 8 + roughSizeOf((obj as Record<string, unknown>)[k], ctx)
  }
  return bytes
}

/** Sum the retained bytes of an object's children (array items / map+set members / own props). */
function sizeOfChildren(obj: object, ctx: WalkCtx): number {
  if (Array.isArray(obj)) return sumValues(obj, ctx)
  if (obj instanceof Set) return sumValues(obj, ctx)
  if (ArrayBuffer.isView(obj)) return (obj as ArrayBufferView).byteLength
  if (obj instanceof Map) {
    let bytes = 0
    for (const [k, v] of obj) bytes += roughSizeOf(k, ctx) + roughSizeOf(v, ctx)
    return bytes
  }
  return sizeOfOwnProps(obj, ctx)
}

/** Rough retained-byte estimate for any value. Shared objects counted once per ctx. */
function roughSizeOf(value: unknown, ctx: WalkCtx): number {
  if (value === null || value === undefined) return 0
  if (ctx.nodes >= MAX_NODES) {
    ctx.truncated = true
    return 0
  }
  ctx.nodes++

  const prim = primitiveSize(value, typeof value)
  if (prim !== null) return prim

  const obj = value as object
  if (ctx.seen.has(obj)) return 0
  ctx.seen.add(obj)
  return 16 + sizeOfChildren(obj, ctx)
}

export type SliceKind = 'map' | 'array' | 'value'

export interface SliceMeasure {
  key: string
  bytes: number
  kind: SliceKind
  /** map: number of sub-keys; array: length; value: 1 */
  count: number
}

export interface SubMeasure {
  slice: string
  subKey: string
  bytes: number
  /** array sub-value: length; otherwise 1 */
  count: number
  /** largest single item (arrays); otherwise === bytes */
  maxItemBytes: number
}

export interface StoreReport {
  total: number
  slices: SliceMeasure[]
  subs: SubMeasure[]
  truncated: boolean
  /** wall-clock ms the walk took */
  elapsedMs: number
  /** total nodes visited */
  nodes: number
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map) && !(v instanceof Set)
}

/** Measure one sub-value of a keyed map, including the largest single array item. */
function measureSub(slice: string, subKey: string, subVal: unknown): SubMeasure {
  const ctx = newCtx()
  const bytes = roughSizeOf(subVal, ctx)
  let count = 1
  let maxItemBytes = bytes
  if (Array.isArray(subVal)) {
    count = subVal.length
    maxItemBytes = 0
    for (const item of subVal) {
      const itemBytes = roughSizeOf(item, newCtx())
      if (itemBytes > maxItemBytes) maxItemBytes = itemBytes
    }
  }
  return { slice, subKey, bytes, count, maxItemBytes }
}

const MAX_SUBS = 50

/**
 * Measure a store state snapshot. Each top-level slice is measured with a
 * FRESH ctx, so cross-slice shared objects are attributed to every slice that
 * references them (we want per-slice self-size, and sharing across these
 * conversation-keyed maps is negligible in practice).
 */
export function measureStore(state: Record<string, unknown>): StoreReport {
  const t0 = performance.now()
  const slices: SliceMeasure[] = []
  const subs: SubMeasure[] = []
  let truncated = false
  let totalNodes = 0
  let total = 0

  for (const [key, value] of Object.entries(state)) {
    if (typeof value === 'function') continue

    const ctx = newCtx()
    const bytes = roughSizeOf(value, ctx)
    truncated = truncated || ctx.truncated
    totalNodes += ctx.nodes
    total += bytes

    if (Array.isArray(value)) {
      slices.push({ key, bytes, kind: 'array', count: value.length })
    } else if (isPlainObject(value)) {
      slices.push({ key, bytes, kind: 'map', count: Object.keys(value).length })
      for (const [subKey, subVal] of Object.entries(value)) {
        if (typeof subVal === 'function') continue
        subs.push(measureSub(key, subKey, subVal))
      }
    } else {
      slices.push({ key, bytes, kind: 'value', count: 1 })
    }
  }

  slices.sort((a, b) => b.bytes - a.bytes)
  subs.sort((a, b) => b.bytes - a.bytes)

  return {
    total,
    slices,
    subs: subs.slice(0, MAX_SUBS),
    truncated,
    elapsedMs: Math.round(performance.now() - t0),
    nodes: totalNodes,
  }
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** Build a GitHub-flavored markdown table from a header row + body rows. */
function mdTable(headers: string[], rows: string[][]): string[] {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`]
  for (const r of rows) out.push(`| ${r.join(' | ')} |`)
  return out
}

const MIN_REPORT_BYTES = 1024

/** Markdown report for clipboard -> paste into chat for analysis. */
export function formatStoreReport(r: StoreReport, iso: string): string {
  const lines: string[] = [
    '# Zustand Store Heap Report',
    '',
    `generated: ${iso}`,
    `estimated total: ${humanBytes(r.total)}`,
    `nodes walked: ${r.nodes.toLocaleString()} in ${r.elapsedMs}ms${r.truncated ? ' (TRUNCATED -- hit node cap)' : ''}`,
    '',
    '## Top-level slices (by size)',
    '',
    ...mdTable(
      ['slice', 'kind', 'count', 'size'],
      r.slices.flatMap(s => (s.bytes >= MIN_REPORT_BYTES ? [[s.key, s.kind, String(s.count), humanBytes(s.bytes)]] : [])),
    ),
    '',
    `## Per-key breakdown (top ${MAX_SUBS} by size)`,
    '',
    ...mdTable(
      ['slice', 'key', 'items', 'size', 'maxItem'],
      r.subs.flatMap(s =>
        s.bytes >= MIN_REPORT_BYTES
          ? [[
              s.slice,
              s.subKey.length > 24 ? `${s.subKey.slice(0, 24)}…` : s.subKey,
              String(s.count),
              humanBytes(s.bytes),
              humanBytes(s.maxItemBytes),
            ]]
          : [],
      ),
    ),
    '',
  ]
  return lines.join('\n')
}
