import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The shared vocabulary of both scope cards (RUN and PLACE): a named section, a
 * label+number stat, a label/value line, and the footer links. Pure and
 * presentational -- no store, no fetch -- so both cards stay unit-testable.
 *
 * Each card NAMES its sections (`THIS RUN` vs `COMMITS`) because one word can
 * answer two questions depending on scope: a conversation is a RUN, a project is
 * a PLACE, and `commits` means "what this agent landed" on one and "what ever
 * landed here" on the other.
 */

export function ScopeSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="border-t border-border/50 px-3 py-2 first:border-t-0">
      {label && <div className="text-[9px] uppercase tracking-wider text-muted-foreground/50 mb-1">{label}</div>}
      {children}
    </div>
  )
}

/** Two-column stat grid -- the shape both cards use for their number blocks. */
export function ScopeStats({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">{children}</div>
}

export function ScopeStat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 text-[10px] min-w-0">
      <span className="text-muted-foreground/60 shrink-0">{label}</span>
      <span className={cn('font-mono tabular-nums truncate', tone ?? 'text-foreground/85')}>{value}</span>
    </div>
  )
}

/** Label on the left, value flushed right -- for identity lines (branch, path). */
export function ScopeLine({
  label,
  value,
  tone,
  title,
}: {
  label: string
  value: ReactNode
  tone?: string
  title?: string
}) {
  return (
    <div className="flex items-baseline gap-2 text-[10px] min-w-0" title={title}>
      <span className="text-muted-foreground/60 shrink-0">{label}</span>
      <span className={cn('font-mono truncate ml-auto text-right', tone ?? 'text-foreground/85')}>{value}</span>
    </div>
  )
}

/** Footer row of `label ►` seams. */
export function ScopeLinks({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-3 border-t border-border/50 px-3 py-1.5">{children}</div>
}

export function ScopeLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      className="text-[10px] text-accent hover:underline cursor-pointer appearance-none bg-transparent border-0 p-0 truncate"
    >
      {children} {'►'}
    </button>
  )
}
