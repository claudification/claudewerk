import { cn } from '@/lib/utils'
import type { ArchivePlan, ArchiveSearchResponse } from './archive-api'
import { formatBytes } from './archive-api'

interface ColdBarProps {
  plan: ArchivePlan | null
  result: ArchiveSearchResponse | null
  running: boolean
  error: string
  includeToolOutput: boolean
  canRun: boolean
  onRun: () => void
  onToggleToolOutput: () => void
}

/** The price, stated before the click. */
function PriceRow({
  plan,
  running,
  canRun,
  includeToolOutput,
  onRun,
  onToggleToolOutput,
}: Pick<ColdBarProps, 'plan' | 'running' | 'canRun' | 'includeToolOutput' | 'onRun' | 'onToggleToolOutput'> & {
  plan: ArchivePlan
}) {
  const armed = canRun && !running
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        disabled={!armed}
        onClick={onRun}
        className={cn(
          'px-2 py-0.5 text-[10px] font-mono rounded border transition-colors',
          armed
            ? 'border-accent/40 text-accent hover:bg-accent/10 cursor-pointer'
            : 'border-surface-inset text-comment cursor-not-allowed',
        )}
      >
        {running ? 'scanning cold archives…' : 'search cold archives'}
      </button>
      <span className="text-[10px] text-comment font-mono">
        {plan.months.length} archived month{plan.months.length === 1 ? '' : 's'},{' '}
        {formatBytes(plan.totalPlaintextBytes)} to scan -- about {plan.estimatedSeconds}s
      </span>
      <span className="flex-1" />
      <button
        type="button"
        aria-pressed={includeToolOutput}
        onClick={onToggleToolOutput}
        className={cn(
          'px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors cursor-pointer',
          includeToolOutput ? 'bg-primary/15 text-primary' : 'text-comment hover:text-foreground',
        )}
      >
        incl. tool output
      </button>
    </div>
  )
}

/** The coverage, stated after it. A truncated scan that reads as complete is the
 *  failure this whole strip exists to prevent. */
function CoverageNote({ result }: { result: ArchiveSearchResponse }) {
  return (
    <>
      <span className="text-[10px] text-comment font-mono">
        {result.hits.length} cold hit{result.hits.length === 1 ? '' : 's'} -- scanned{' '}
        {result.scannedMonths.join(', ') || 'nothing'} ({result.rowsScanned.toLocaleString()} rows,{' '}
        {formatBytes(result.bytesScanned)}) in {(result.elapsedMs / 1000).toFixed(1)}s
      </span>
      {result.truncated && (
        <span className="text-[10px] text-amber-400 font-mono">
          INCOMPLETE -- {result.truncatedReason === 'limit' ? 'hit the result limit' : 'ran out of time'}. NOT searched:{' '}
          {result.skippedMonths.join(', ') || 'rest of the last month'}
        </span>
      )}
    </>
  )
}

/** The cold-archive strip under the results: price before, coverage after. */
export function ColdBar({ plan, result, error, ...controls }: ColdBarProps) {
  if (!plan) return null
  return (
    <div className="px-4 py-2 border-t border-surface-inset bg-background flex flex-col gap-1">
      <PriceRow plan={plan} {...controls} />
      {error && <span className="text-[10px] text-red-400 font-mono">{error}</span>}
      {result && <CoverageNote result={result} />}
    </div>
  )
}
