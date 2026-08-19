/**
 * The small shared pieces of the overseer window -- status pill, section block,
 * stat, the empty state.
 *
 * Their own file because five components each used twice is exactly the shape
 * that otherwise grows a 400-line window component nobody can find anything in.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Status -> how it should read at a glance. A strategy map rather than a chain:
 *  five branches on one key is the covenant's threshold. */
const STATUS_TONE: Record<string, string> = {
  armed: 'text-idle border-[color:var(--idle)]/45 bg-[color:var(--idle)]/10',
  running: 'text-active border-[color:var(--active)]/45 bg-[color:var(--active)]/10',
  paused: 'text-muted-foreground border-border bg-muted/10',
  complete: 'text-active border-[color:var(--active)]/45 bg-[color:var(--active)]/10',
  aborted: 'text-destructive border-destructive/45 bg-destructive/10',
}

const UNKNOWN_TONE = 'text-fg-dim border-border'

export function StatusPill({ status }: { status: string | null }) {
  return (
    <span
      className={cn(
        'text-chrome uppercase px-1.5 py-0.5 border shrink-0',
        status ? (STATUS_TONE[status] ?? UNKNOWN_TONE) : UNKNOWN_TONE,
      )}
    >
      {status ?? 'no run'}
    </span>
  )
}

export function Block({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="px-3 py-2.5 border-b border-border-subtle">
      <div className="flex items-center justify-between text-chrome uppercase text-fg-dim mb-1.5">
        <span>{title}</span>
        {extra}
      </div>
      {children}
    </div>
  )
}

export function Stat({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className={cn('text-base font-bold leading-none tabular-nums', tone ?? 'text-foreground')}>{value}</span>
      <span className="text-chrome text-fg-dim">{label}</span>
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 text-[11px] text-fg-dim italic">{children}</div>
}

/** A run's short name for the rail and the heading. The project URI's tail is
 *  the only part a human reads, and the full URI never fits. */
export function projectTail(project: string): string {
  const parts = project.split('/')
  return parts[parts.length - 1] || project
}

/** "12s ago" / "4m ago". Beats and baton entries are only ever interesting
 *  relative to now -- an absolute ISO stamp makes you do the subtraction. */
export function ago(iso: string | null, nowMs: number): string {
  if (!iso) return 'never'
  const secs = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  return `${Math.round(secs / 3600)}h ago`
}
