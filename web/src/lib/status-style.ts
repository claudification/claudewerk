import type { LiveStatus, LiveStatusState } from './types'

/**
 * THE STATUS — one shared style table for the agent's self-reported `set_status`,
 * so the conversation-list badge and the transcript self-report block read the
 * same. Keyed off `state`; each entry carries a label + Tailwind classes for the
 * text, the faint fill, the border, and the status dot.
 */
export const STATUS_META: Record<
  LiveStatusState,
  { label: string; text: string; bg: string; border: string; dot: string }
> = {
  working: {
    label: 'WORKING',
    text: 'text-sky-400',
    bg: 'bg-sky-400/5',
    border: 'border-sky-400/20',
    dot: 'bg-sky-400',
  },
  done: {
    label: 'DONE',
    text: 'text-emerald-400',
    bg: 'bg-emerald-400/5',
    border: 'border-emerald-400/20',
    dot: 'bg-emerald-400',
  },
  needs_you: {
    label: 'NEEDS YOU',
    text: 'text-amber-400',
    bg: 'bg-amber-400/5',
    border: 'border-amber-400/20',
    dot: 'bg-amber-400',
  },
  blocked: {
    label: 'BLOCKED',
    text: 'text-rose-400',
    bg: 'bg-rose-400/5',
    border: 'border-rose-400/20',
    dot: 'bg-rose-400',
  },
}

/** The optional detail fields, in display order, each with its own accent tone.
 *  `empty is signal` — only the populated ones render. */
export const STATUS_FIELDS: Array<{ key: keyof LiveStatus; label: string; tone: string }> = [
  { key: 'done', label: 'done', tone: 'text-emerald-400' },
  { key: 'pending', label: 'pending', tone: 'text-amber-400' },
  { key: 'blocked', label: 'blocked', tone: 'text-rose-400' },
  { key: 'caveats', label: 'caveats', tone: 'text-orange-400' },
  { key: 'notes', label: 'notes', tone: 'text-muted-foreground' },
]
