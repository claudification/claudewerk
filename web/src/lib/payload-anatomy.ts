/**
 * Payload anatomy -- "which FIELD is the megabyte?"
 *
 * `ws-stats` can already tell you the panel took 4 MB inbound; the per-message
 * perf sample can tell you 707 KB of it was one `conversations_list`. Neither
 * tells you the thing that actually decides what to fix: WHICH field inside that
 * message paid for it, and whether those bytes were the same value repeated on
 * every row.
 *
 * That gap cost a hand-written probe script to close once (2026-08-14: the boot
 * snapshot was 696 KB for 55 conversations, and 77% of it was three detail-only
 * fields -- `costTimeline`, `monitors`, and `spinnerVerbs`, the last being ONE
 * identical 116-verb array shipped 55 times). This module makes that answer fall
 * out of the perf monitor instead.
 *
 * Cost: a full re-serialize of the analysed payload. Callers must run it rarely
 * (see `wire-stats`: once per message type, only over a size threshold, only
 * while the perf monitor is on).
 */

/** One field's contribution to a payload's byte size. */
export interface FieldWeight {
  name: string
  bytes: number
  /** Fraction (0..1) of the analysed payload this field accounts for. */
  share: number
  /** Rows carrying the field -- list payloads only. */
  rows?: number
  /** List payloads only: the value was byte-identical on EVERY row carrying it,
   *  i.e. these bytes are pure duplication and belong somewhere sent once. */
  duplicated?: boolean
}

/** Rows sampled from a list payload. Beyond this the per-field totals are
 *  extrapolated -- an estimate is worth far more than skipping the analysis. */
const SAMPLE_ROWS = 200

function byteLen(v: unknown): number {
  if (v === undefined) return 0
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Per-field accumulator for a list payload. Holds at most ONE serialized
 *  sample per field, so distinctness detection stays memory-bounded. */
interface FieldAgg {
  bytes: number
  rows: number
  sample?: string
  allSame: boolean
}

/**
 * The heaviest array-of-objects property, when one field dominates the payload.
 * That is the list whose ROWS are worth breaking down (`conversations` inside a
 * `conversations_list`); anything smaller is better read as a flat object.
 */
function findDominantList(weights: Array<[string, number]>, obj: Record<string, unknown>, total: number) {
  for (const [name, bytes] of weights) {
    const v = obj[name]
    if (!Array.isArray(v) || v.length < 2 || !isRecord(v[0])) continue
    if (bytes < total / 2) continue
    return { name, rows: v as Array<Record<string, unknown>> }
  }
  return undefined
}

function aggregateRows(rows: Array<Record<string, unknown>>): { aggs: Map<string, FieldAgg>; scale: number } {
  const sampled = rows.length > SAMPLE_ROWS ? rows.slice(0, SAMPLE_ROWS) : rows
  const scale = rows.length / sampled.length
  const aggs = new Map<string, FieldAgg>()
  for (const row of sampled) {
    for (const [name, value] of Object.entries(row)) {
      if (value === undefined) continue
      const serialized = JSON.stringify(value) ?? ''
      const agg = aggs.get(name) ?? { bytes: 0, rows: 0, sample: serialized, allSame: true }
      agg.bytes += serialized.length
      agg.rows += 1
      if (agg.sample !== serialized) agg.allSame = false
      aggs.set(name, agg)
    }
  }
  return { aggs, scale }
}

function rankListFields(rows: Array<Record<string, unknown>>, topN: number): FieldWeight[] {
  const { aggs, scale } = aggregateRows(rows)
  let total = 0
  for (const agg of aggs.values()) total += agg.bytes
  if (total === 0) return []
  const out: FieldWeight[] = []
  for (const [name, agg] of aggs) {
    out.push({
      name,
      bytes: Math.round(agg.bytes * scale),
      share: agg.bytes / total,
      rows: Math.round(agg.rows * scale),
      // Only meaningful when the field appeared on more than one row.
      duplicated: agg.allSame && agg.rows > 1,
    })
  }
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, topN)
}

function rankFlatFields(weights: Array<[string, number]>, total: number, topN: number): FieldWeight[] {
  return (
    weights
      // Weightless fields (undefined values) are noise, not findings -- the list
      // path skips them too, so both breakdowns report the same thing.
      .filter(([, bytes]) => bytes > 0)
      .map(([name, bytes]) => ({ name, bytes, share: total > 0 ? bytes / total : 0 }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, topN)
  )
}

/**
 * Break a wire payload down into its heaviest fields, heaviest first.
 *
 * For a payload dominated by one array of objects (the bulk-list shape) the
 * breakdown is PER ROW FIELD summed across rows -- `costTimeline: 221 KB over 55
 * rows` -- because that is the actionable unit. Otherwise it is a flat
 * top-level-property breakdown. Returns [] for a non-object payload.
 */
export function analysePayload(payload: unknown, topN = 8): FieldWeight[] {
  if (!isRecord(payload)) return []
  const weights = Object.entries(payload).map(([k, v]) => [k, byteLen(v)] as [string, number])
  let total = 0
  for (const [, bytes] of weights) total += bytes
  if (total === 0) return []
  const list = findDominantList(weights, payload, total)
  return list ? rankListFields(list.rows, topN) : rankFlatFields(weights, total, topN)
}

/** One-line rendering of a field weight, for the report + HUD. */
export function formatFieldWeight(f: FieldWeight): string {
  const kb = (f.bytes / 1024).toFixed(1)
  const pct = (f.share * 100).toFixed(0)
  const rows = f.rows !== undefined ? ` over ${f.rows} rows` : ''
  const dup = f.duplicated ? ' DUPLICATED (identical on every row)' : ''
  return `${f.name} ${kb}KB ${pct}%${rows}${dup}`
}
