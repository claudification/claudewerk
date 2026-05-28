/**
 * Shared primitives for the structured recap report (Recap 2.0).
 * Used by the scorecard, analytics, section cards, and drill-down.
 */

import type { RecapItem } from '@shared/protocol'
import { cn } from '@/lib/utils'

/** Short citation form: conversation ids -> 12 chars, anything else -> 8. */
function shortConv(id: string): string {
  return id.startsWith('conv_') ? id.slice(0, 12) : id.slice(0, 8)
}

type Tone = 'muted' | 'accent' | 'success' | 'warning' | 'danger'

const TONES: Record<Tone, string> = {
  muted: 'bg-muted/60 text-muted-foreground',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/20 text-warning',
  danger: 'bg-destructive/15 text-destructive',
}

function Chip({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: Tone; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', TONES[tone])}
    >
      {children}
    </span>
  )
}

function InferredBadge() {
  return (
    <Chip tone="warning" title="Inferred from transcript text -- not backed by a commit or task">
      inferred
    </Chip>
  )
}

/** Citation chips for one item: conversations (clickable in-app) + commit hashes. */
export function Citations({
  item,
  onOpenConversation,
}: {
  item: RecapItem
  onOpenConversation?: (id: string) => void
}) {
  const convs = item.conversations ?? []
  const commits = item.commits ?? []
  if (!item.inferred && convs.length === 0 && commits.length === 0) return null
  return (
    <span className="ml-1 inline-flex flex-wrap items-center gap-1 align-middle">
      {item.inferred && <InferredBadge />}
      {convs.map(c =>
        onOpenConversation ? (
          <button
            key={c}
            type="button"
            onClick={() => onOpenConversation(c)}
            className="rounded bg-accent/15 px-1 py-0.5 font-mono text-[10px] text-accent hover:bg-accent/30"
            title={`Open conversation ${c}`}
          >
            {shortConv(c)}
          </button>
        ) : (
          <code key={c} className="rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
            {shortConv(c)}
          </code>
        ),
      )}
      {commits.map(h => (
        <code
          key={h}
          className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
          title="commit"
        >
          {h.slice(0, 7)}
        </code>
      ))}
    </span>
  )
}

/** A labelled row of plain text chips (keywords, hashtags, stakeholders...). */
export function ChipRow({ label, items, tone = 'muted' }: { label: string; items: string[]; tone?: Tone }) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {items.map(item => (
        <Chip key={item} tone={tone}>
          {item}
        </Chip>
      ))}
    </div>
  )
}
