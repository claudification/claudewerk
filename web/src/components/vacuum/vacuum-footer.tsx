/**
 * Totals, the gate verdict, and the actions.
 *
 * The gate is rendered whether it passes or fails, and APPLY is disabled with
 * the gate's LITERAL reason beside it. The nightly cron silently skips when the
 * gate fails, and that silence is why a 10 GB database went unreclaimed for
 * months -- a refusal nobody can see is indistinguishable from a job that
 * never ran.
 */

import { AlertTriangle, Check, RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { describeBytes, formatBytes, formatDuration, formatMeasuredBytes } from './format'
import type { VacuumEstimate } from './vacuum-types'

interface Props {
  estimate: VacuumEstimate
  busy: boolean
  measuringBytes: boolean
  onMeasureBytes: () => void
  onPlan: () => void
  onApply: () => void
}

export function VacuumFooter({ estimate, busy, measuringBytes, onMeasureBytes, onPlan, onApply }: Props) {
  const { gate, vacuum, bytes, footprint } = estimate
  const blocked = !gate.ok

  return (
    <div className="border-t border-border bg-muted/30 px-3 py-2 space-y-2 shrink-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">Estimated reclaim</span>
        <span className="font-mono text-sm font-medium tabular-nums">
          {formatMeasuredBytes(estimate.projectedTotalBytes, bytes)}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3 text-[10px] text-muted-foreground">
        <span>
          store.db {formatBytes(footprint.fileBytes)}
          {bytes.provenance !== 'unmeasured' && <> to about {formatBytes(estimate.projectedDbBytesAfter)}</>}
        </span>
        <button type="button" onClick={onMeasureBytes} className="underline underline-offset-2 hover:text-foreground">
          {measuringBytes ? 'measuring bytes...' : `${describeBytes(bytes)} - re-measure (~2 min)`}
        </button>
      </div>

      <div
        className={`flex items-start gap-2 rounded px-2 py-1.5 text-[10px] leading-relaxed ${
          blocked ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
        }`}
      >
        {blocked ? <AlertTriangle className="size-3 shrink-0 mt-0.5" /> : <Check className="size-3 shrink-0 mt-0.5" />}
        <span>
          <strong>Backup gate:</strong> {gate.reason}
          {!blocked && (
            <>
              {' '}
              Nothing is deleted until each month is exported to a cold archive and that archive is verified against the
              live database.
            </>
          )}
        </span>
      </div>

      <div className="text-[10px] text-muted-foreground leading-relaxed">
        Reclaiming pages needs a <code className="font-mono">VACUUM</code>: the broker stops answering for roughly{' '}
        {formatDuration(vacuum.estimatedLockSeconds)} while it rewrites the database. WebSockets stay connected.
        {vacuum.willEnableIncremental &&
          ' This run also switches to incremental auto-vacuum, so it is the last full one.'}
        {!vacuum.hasHeadroom && (
          <span className="text-destructive">
            {' '}
            Not enough free disk ({formatBytes(vacuum.freeBytes)} free, needs {formatBytes(vacuum.neededBytes)}) -- the
            vacuum step will be skipped.
          </span>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 pt-0.5">
        <Button variant="outline" size="sm" onClick={onPlan} disabled={busy}>
          <RefreshCw className={`size-3 ${busy ? 'animate-spin' : ''}`} />
          Dry run
        </Button>
        <Button variant="destructive" size="sm" onClick={onApply} disabled={busy || blocked}>
          Vacuum
        </Button>
      </div>
    </div>
  )
}
