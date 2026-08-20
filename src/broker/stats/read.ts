/**
 * THE STATS TABLE's read side.
 *
 * The in-memory ring is still the hot read -- the ~2 Hz `WallFrame` is built
 * from it, never from here. This is the BOOT read: one query per kind+metric,
 * once, to refill the rings that a restart emptied.
 *
 * The query is the one the unique tuple already indexes -- object, metric,
 * window -- so no extra index exists for it.
 */

import type { StatMetric, StatObjectKind, StatSeries } from '../../shared/stats'
import { statsDb } from './db'

interface Row {
  node_id: string
  kind: string
  name: string
  label: string | null
  ts: number
  value: number
}

/**
 * Every object of `kind` that has readings of `metric` at or after `since`,
 * each series oldest first. Objects with nothing in the window are absent
 * rather than present-and-empty: a node that has not reported since yesterday
 * has no sparkline, and an empty array would invite one to be drawn.
 *
 * Flushing first is the caller's job. The boot path reads before anything has
 * been buffered, and a mid-life caller that wants its own last 3 seconds
 * included can call `flushStats()`.
 */
export function readStatsByKind(kind: StatObjectKind, metric: StatMetric, since: number): StatSeries[] {
  const db = statsDb()
  if (!db) return []
  try {
    const rows = db
      .query(`
        SELECT o.node_id, o.kind, o.name, o.label, s.ts, s.value
        FROM stat_samples s
        JOIN stat_objects o ON o.id = s.object_id
        WHERE o.kind = $kind AND s.metric = $metric AND s.ts >= $since
        ORDER BY o.id, s.ts
      `)
      .all({ kind, metric, since } as never) as Row[]

    const byObject = new Map<string, StatSeries>()
    for (const r of rows) {
      const key = `${r.node_id} ${r.name}`
      let series = byObject.get(key)
      if (!series) {
        series = {
          ref: { nodeId: r.node_id, kind, name: r.name, ...(r.label ? { label: r.label } : {}) },
          points: [],
        }
        byObject.set(key, series)
      }
      series.points.push({ ts: r.ts, value: r.value })
    }
    return [...byObject.values()]
  } catch (err) {
    console.error('[stats] read failed:', err)
    return []
  }
}
