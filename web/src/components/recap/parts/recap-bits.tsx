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

/** Deterministic hue (0-359) from a string -- the SAME term always gets the SAME
 *  color, so a dense keyword/hashtag cloud separates visually instead of reading
 *  as one flat grey wall. */
function hashHue(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
  return h % 360
}

/** A tag chip colored by a hash of its own text. Inline HSL (Tailwind can't do
 *  dynamic hues); saturation/lightness are fixed so every hue stays legible on
 *  the dark report surface. */
function HashChip({ text }: { text: string }) {
  const h = hashHue(text)
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        backgroundColor: `hsl(${h} 45% 22%)`,
        color: `hsl(${h} 78% 80%)`,
        border: `1px solid hsl(${h} 45% 34%)`,
      }}
    >
      {text}
    </span>
  )
}

/** A labelled row of plain text chips (keywords, hashtags, stakeholders...).
 *  Pass `hash` to color each chip by a hash of its text (for tag clouds). */
export function ChipRow({
  label,
  items,
  tone = 'muted',
  hash = false,
}: {
  label: string
  items: string[]
  tone?: Tone
  hash?: boolean
}) {
  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {items.map(item =>
        hash ? (
          <HashChip key={item} text={item} />
        ) : (
          <Chip key={item} tone={tone}>
            {item}
          </Chip>
        ),
      )}
    </div>
  )
}

/** A labelled bullet list for SENTENCE-shaped metadata (goals, discoveries,
 *  side-effects) -- these are statements, not tags, so chip styling turned them
 *  into unreadable paragraph-soup. `tone` tints the marker + text (warning for
 *  side-effects). */
export function MetaList({
  label,
  items,
  tone = 'muted',
}: {
  label: string
  items: string[]
  tone?: 'muted' | 'warning'
}) {
  if (!items.length) return null
  const textClass = tone === 'warning' ? 'text-warning/90' : 'text-foreground/85'
  const markerClass = tone === 'warning' ? 'bg-warning/70' : 'bg-muted-foreground/50'
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <ul className="flex flex-col gap-1">
        {items.map(item => (
          <li key={item} className={cn('flex items-start gap-2 text-xs leading-snug', textClass)}>
            <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', markerClass)} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
