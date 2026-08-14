/**
 * Wire-payload table for the Perf tab.
 *
 * Answers "what did we DOWNLOAD?" -- bytes keyed on message type, heaviest
 * first, with the field-level anatomy of the fattest instance of each fat type
 * expanded inline. A field flagged DUP carried a byte-identical value on every
 * row of a list payload, i.e. those bytes are pure duplication.
 */

import { Fragment, useSyncExternalStore } from 'react'
import { formatFieldWeight } from '@/lib/payload-anatomy'
import { cn } from '@/lib/utils'
import { getWireStats, subscribeWireStats, totalWireBytes, type WireTypeStat } from '@/lib/wire-stats'

const kb = (bytes: number) => (bytes / 1024).toFixed(1)

/** Fat payloads earn attention; small ones stay grey. */
function bytesColor(bytes: number): string {
  if (bytes >= 512 * 1024) return 'text-destructive'
  if (bytes >= 64 * 1024) return 'text-warning'
  return 'text-foreground'
}

function FieldList({ stat }: { stat: WireTypeStat }) {
  if (!stat.fields || stat.fields.length === 0) return null
  return (
    <tr className="border-b border-primary/4">
      <td colSpan={5} className="py-1 pl-3 text-[10px] text-comment">
        {stat.fields.map(f => (
          <div key={f.name} className={cn(f.duplicated && 'text-warning')}>
            {formatFieldWeight(f)}
          </div>
        ))}
      </td>
    </tr>
  )
}

export function WirePayloadTable() {
  const rows = useSyncExternalStore(subscribeWireStats, getWireStats)
  if (rows.length === 0) {
    return (
      <div className="text-center text-comment text-[10px] py-3">
        No inbound payload recorded yet -- a wire message has to arrive while the monitor is on
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider font-bold text-accent">
        Wire payload -- {kb(totalWireBytes())} KB in
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] tabular-nums">
          <thead>
            <tr className="text-comment border-b border-primary/12">
              <th className="text-left font-normal py-0.5 pr-2">message</th>
              <th className="text-right font-normal py-0.5 pl-2">n</th>
              <th className="text-right font-normal py-0.5 pl-2">KB</th>
              <th className="text-right font-normal py-0.5 pl-2">max KB</th>
              <th className="text-right font-normal py-0.5 pl-2">cpu ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <Fragment key={r.type}>
                <tr className="border-b border-primary/4 hover:bg-surface-inset/50">
                  <td className="text-left py-0.5 pr-2 truncate max-w-[160px] text-foreground" title={r.type}>
                    {r.type}
                  </td>
                  <td className="text-right py-0.5 pl-2 text-foreground">{r.n}</td>
                  <td className={cn('text-right py-0.5 pl-2', bytesColor(r.bytes))}>{kb(r.bytes)}</td>
                  <td className={cn('text-right py-0.5 pl-2', bytesColor(r.maxBytes))}>{kb(r.maxBytes)}</td>
                  <td className="text-right py-0.5 pl-2 text-comment">{r.cpuMs.toFixed(1)}</td>
                </tr>
                <FieldList stat={r} />
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
