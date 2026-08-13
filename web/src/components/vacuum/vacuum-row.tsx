/**
 * One category row: a checkbox, an optional age threshold, and a measured
 * estimate. Shaped after a browser's "Clear browsing data".
 */

import { cn } from '@/lib/utils'

export interface VacuumRowProps {
  label: string
  /** The measured detail line -- rows, files, months. Always facts. */
  detail: string
  /** Right-aligned reclaim figure, already formatted. */
  size: string
  checked: boolean
  onCheckedChange: (next: boolean) => void
  days?: number
  onDaysChange?: (next: number) => void
  /** Set when the row cannot be actioned; disables it and explains why. */
  disabledReason?: string
  /** Informational rows report a finding but are not a delete the user picks. */
  informational?: boolean
}

export function VacuumRow(props: VacuumRowProps) {
  const { label, detail, size, checked, onCheckedChange, days, onDaysChange, disabledReason, informational } = props
  const disabled = Boolean(disabledReason) || informational

  return (
    <div
      className={cn(
        'flex items-start gap-3 py-2 px-1 border-b border-border/50 last:border-0',
        disabled && 'opacity-60',
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-3.5 accent-primary disabled:cursor-not-allowed"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={e => onCheckedChange(e.target.checked)}
        aria-label={label}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium">{label}</span>
          {days !== undefined && onDaysChange && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              older than
              <input
                type="number"
                min={1}
                max={3650}
                value={days}
                disabled={disabled}
                onChange={e => onDaysChange(Math.max(1, Number(e.target.value) || 1))}
                className="w-12 rounded border border-border bg-background px-1 py-0.5 text-center font-mono text-[10px]"
                aria-label={`${label} age threshold in days`}
              />
              days
            </span>
          )}
          {informational && (
            <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
              info
            </span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground leading-relaxed">{detail}</div>
        {disabledReason && <div className="text-[10px] text-destructive leading-relaxed">{disabledReason}</div>}
      </div>
      <span className="shrink-0 font-mono text-xs tabular-nums">{size}</span>
    </div>
  )
}
