/**
 * Per-message impact rollup -- the "what does each wire message DO?" view over
 * the perf ring buffer. Distinct concern from the buffer itself (perf-metrics):
 * this is pure aggregation, keyed on each sample's `msgType` attribution tag.
 */

import type { PerfEntry } from './perf-metrics'

export interface MessageImpact {
  msgType: string
  applies: number // count of synchronous apply spans (category 'message')
  applyMs: number // total synchronous handler cost
  renderMs: number // total React commit cost (category 'render', excl. commit->paint)
  paintMs: number // total commit->paint cost
  groupingMs: number // total transcript grouping cost
  otherMs: number // any other attributed cost
  totalMs: number // sum of all attributed cost
}

/**
 * Roll the ring buffer up by attributed message type -- the "per-message
 * impact" view. Apply cost is exact (one span per message); render / paint /
 * grouping cost is credited to the batch's dominant message type (see
 * perf-message-context), so a mixed flush approximates. Tab-hidden artifacts
 * are excluded (their commit->paint gap is wall-clock idle, not work).
 *
 * The 'ws' category (flush / onmessage) is also excluded: the flush wall-time
 * is measured AROUND the per-message apply loop, so it already contains every
 * `apply:<type>` span in that batch. Summing both double-counts the handler
 * cost into Total -- so transport overhead stays in the ws summary only, and
 * Total = apply + render + paint + grouping + (genuinely-other) downstream work.
 */
export function messageImpactStats(entries: readonly PerfEntry[]): MessageImpact[] {
  const map = new Map<string, MessageImpact>()
  const get = (k: string): MessageImpact => {
    let v = map.get(k)
    if (!v) {
      v = { msgType: k, applies: 0, applyMs: 0, renderMs: 0, paintMs: 0, groupingMs: 0, otherMs: 0, totalMs: 0 }
      map.set(k, v)
    }
    return v
  }
  type CategoryFn = (v: MessageImpact, e: PerfEntry) => void
  const categoryHandlers: Record<string, CategoryFn> = {
    message: (v, e) => {
      v.applies += 1
      v.applyMs += e.durationMs
    },
    render: (v, e) => {
      if (e.label.endsWith('.commit->paint')) v.paintMs += e.durationMs
      else v.renderMs += e.durationMs
    },
    grouping: (v, e) => {
      v.groupingMs += e.durationMs
    },
  }
  const applyOther: CategoryFn = (v, e) => {
    v.otherMs += e.durationMs
  }
  for (const e of entries) {
    if (!e.msgType || e.detail?.includes('suspended')) continue
    if (e.category === 'ws') continue // transport overhead wraps apply -- would double-count
    const v = get(e.msgType)
    v.totalMs += e.durationMs
    ;(categoryHandlers[e.category] ?? applyOther)(v, e)
  }
  return [...map.values()].toSorted((a, b) => b.totalMs - a.totalMs)
}
