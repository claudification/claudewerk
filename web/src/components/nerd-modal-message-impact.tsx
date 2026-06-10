/**
 * Per-message impact rollup for the Perf tab.
 *
 * Answers "what does each inbound wire message DO?" -- the synchronous handler
 * cost (exact, one span per message) alongside the render / paint / grouping
 * cost its store mutation triggered (credited to the batch's dominant type;
 * see perf-message-context). Sorted by total attributed cost, heaviest first.
 */

import { durationColor, type PerfEntry } from '@/lib/perf-metrics'
import { type MessageImpact, messageImpactStats } from '@/lib/perf-rollup'
import { cn } from '@/lib/utils'

type NumKey = Exclude<keyof MessageImpact, 'msgType'>
const COLS: Array<{ key: NumKey; label: string; ms?: boolean }> = [
  { key: 'applies', label: 'n' },
  { key: 'applyMs', label: 'apply', ms: true },
  { key: 'renderMs', label: 'render', ms: true },
  { key: 'paintMs', label: 'paint', ms: true },
  { key: 'groupingMs', label: 'group', ms: true },
  { key: 'totalMs', label: 'total', ms: true },
]

export function MessageImpactTable({ entries }: { entries: PerfEntry[] }) {
  const rows = messageImpactStats(entries)
  if (rows.length === 0) {
    return (
      <div className="text-center text-comment text-[10px] py-3">
        No attributed messages yet -- a wire message has to arrive while the monitor is on
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider font-bold text-info">By message</div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] tabular-nums">
          <thead>
            <tr className="text-comment border-b border-primary/12">
              <th className="text-left font-normal py-0.5 pr-2">message</th>
              {COLS.map(c => (
                <th key={c.key} className="text-right font-normal py-0.5 pl-2">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.msgType} className="border-b border-primary/4 hover:bg-surface-inset/50">
                <td className="text-left py-0.5 pr-2 truncate max-w-[160px] text-foreground" title={r.msgType}>
                  {r.msgType}
                </td>
                {COLS.map(c => {
                  const v = r[c.key]
                  return (
                    <td
                      key={c.key}
                      className={cn('text-right py-0.5 pl-2', c.ms ? durationColor(v) : 'text-foreground')}
                    >
                      {c.ms ? `${v.toFixed(1)}` : v}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
