/**
 * The live step stream for a plan or apply.
 *
 * Every step the broker broadcasts is shown, including skips WITH their reason.
 * A step that reports no reason cannot be told apart from one that silently
 * vanished, which is exactly the ambiguity you do not want at the point where
 * rows are already gone.
 */

import type { VacuumStepMessage } from '@shared/protocol'
import { formatBytes, formatRows } from './format'

const STATUS_CLASS: Record<VacuumStepMessage['status'], string> = {
  started: 'text-muted-foreground',
  ok: 'text-foreground',
  skipped: 'text-muted-foreground',
  failed: 'text-destructive',
}

const STATUS_MARK: Record<VacuumStepMessage['status'], string> = {
  started: '>',
  ok: 'ok',
  skipped: '--',
  failed: 'XX',
}

export function RunLog({ steps }: { steps: VacuumStepMessage[] }) {
  if (steps.length === 0) return null
  const last = steps[steps.length - 1]

  return (
    <div className="border-t border-border px-3 py-2 space-y-1 max-h-48 overflow-y-auto shrink-0">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{last.dryRun ? 'Dry run' : 'Vacuum run'}</span>
        <span className="font-mono">{last.runId}</span>
      </div>
      {steps.map((step, i) => (
        <div key={`${step.runId}-${step.step}-${i}`} className="flex items-start gap-2 font-mono text-[10px]">
          <span className={`w-5 shrink-0 ${STATUS_CLASS[step.status]}`}>{STATUS_MARK[step.status]}</span>
          <span className="w-32 shrink-0 truncate">{step.step}</span>
          <span className={`min-w-0 flex-1 ${STATUS_CLASS[step.status]}`}>{step.detail}</span>
        </div>
      ))}
      {last.step === 'done' && !last.dryRun && (
        <div className="pt-1 font-mono text-[10px] text-muted-foreground">
          {formatRows(last.rowsBefore)} to {formatRows(last.rowsAfter)} rows - {formatBytes(last.dbBytesBefore)} to{' '}
          {formatBytes(last.dbBytesAfter)}
        </div>
      )}
    </div>
  )
}
