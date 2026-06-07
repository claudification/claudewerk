/**
 * Renders one debug-control trace: the per-seam waterfall (+ms from web_send)
 * and the final result. Used by the debug-control modal.
 */

import type { DebugTrace } from '@/hooks/debug-control-store'
import { JsonInspector } from '../json-inspector'
import { StructuredView } from '../structured-view'

const SEAM_COLOR: Record<string, string> = {
  web_send: 'text-cyan-400/80',
  broker_recv: 'text-blue-400/80',
  broker_forward: 'text-blue-400/80',
  agenthost_recv: 'text-purple-400/80',
  agenthost_to_cc: 'text-purple-400/80',
  cc_to_agenthost: 'text-emerald-400/80',
  agenthost_to_broker: 'text-blue-400/80',
  broker_to_web: 'text-cyan-400/80',
  error: 'text-red-400',
}

export function DebugTraceWaterfall({ trace }: { trace: DebugTrace }) {
  const t0 = trace.events[0]?.t ?? trace.sentAt
  return (
    <div className="border border-border/60 bg-muted/20 rounded text-[10px] font-mono">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border/40">
        <span className="text-accent">
          {trace.channel}:{trace.command}
        </span>
        {trace.result && (
          <span className={trace.result.ok ? 'text-emerald-400' : 'text-red-400'}>
            {trace.result.ok ? 'OK' : trace.result.code || 'FAIL'}
          </span>
        )}
        <span className="flex-1" />
        {trace.result && <span className="text-muted-foreground/50">{trace.result.elapsedMs}ms</span>}
      </div>

      <div className="px-2 py-1 flex flex-col gap-0.5">
        {trace.events.map((e, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only, stable-order trace log
          <div key={`${e.seam}-${i}`} className="flex items-center gap-2">
            <span className="text-muted-foreground/40 tabular-nums w-10 text-right">+{Math.max(0, e.t - t0)}ms</span>
            <span className={`w-36 ${SEAM_COLOR[e.seam] ?? 'text-muted-foreground'}`}>{e.seam}</span>
            {e.ok !== undefined && (
              <span className={e.ok ? 'text-emerald-400/70' : 'text-red-400/70'}>{e.ok ? '✓' : '✗'}</span>
            )}
            <span className="text-muted-foreground/70 flex-1 truncate">{e.detail}</span>
            {e.raw != null && <JsonInspector title={e.seam} data={e.raw as Record<string, unknown>} raw={e.raw} />}
          </div>
        ))}
      </div>

      {trace.result && (
        <div className="px-2 py-1 border-t border-border/40 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground/50 shrink-0">result</span>
            <span className="flex-1" />
            <JsonInspector
              title={`${trace.channel}:${trace.command} result`}
              data={trace as unknown as Record<string, unknown>}
              raw={trace.result}
            />
          </div>
          {trace.result.error ? (
            <span className="text-red-400/80 break-words">{trace.result.error}</span>
          ) : (
            <StructuredView value={trace.result.response ?? null} maxHeight="16rem" />
          )}
        </div>
      )}
    </div>
  )
}
