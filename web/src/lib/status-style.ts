import type { LiveStatus, LiveStatusState } from './types'

/**
 * THE STATUS — one shared style table for the agent's self-reported `set_status`,
 * so the conversation-list badge and the transcript self-report block read the
 * same. Keyed off `state`; each entry carries a label + Tailwind classes for the
 * text, the faint fill, the border, and the status dot.
 */
export const STATUS_META: Record<
  LiveStatusState,
  { label: string; icon: string; text: string; bg: string; border: string; dot: string }
> = {
  working: {
    label: 'WORKING',
    icon: '●',
    text: 'text-sky-400',
    bg: 'bg-sky-400/5',
    border: 'border-sky-400/20',
    dot: 'bg-sky-400',
  },
  done: {
    label: 'DONE',
    icon: '✓',
    text: 'text-emerald-400',
    bg: 'bg-emerald-400/5',
    border: 'border-emerald-400/20',
    dot: 'bg-emerald-400',
  },
  needs_you: {
    label: 'NEEDS YOU',
    icon: '!',
    text: 'text-amber-400',
    bg: 'bg-amber-400/5',
    border: 'border-amber-400/20',
    dot: 'bg-amber-400',
  },
  blocked: {
    label: 'BLOCKED',
    icon: '⊘',
    text: 'text-rose-400',
    bg: 'bg-rose-400/5',
    border: 'border-rose-400/20',
    dot: 'bg-rose-400',
  },
}

/** Glanceable marker for a disposable conversation (safe_to_close). */
export const CLOSEABLE_ICON = '✕'

/**
 * A self-reported status is SUPERSEDED when a user impulse (a message posted to
 * the conversation) arrived AFTER the status was set: the report predates what
 * the user did next, so it no longer reflects reality and must read as stale,
 * not authoritative. Deliberately keyed off `lastInputAt` (user impulse) ONLY,
 * never `lastActivity` -- the agent emits text right after set_status, so
 * lastActivity always edges just past updatedAt and would falsely stale every
 * status. (Mirrors list_conversations' statusAge vs lastInputAge pairing.)
 */
export function isStatusSuperseded(status: LiveStatus | undefined, lastInputAt: number | undefined): boolean {
  if (!status || lastInputAt == null) return false
  return lastInputAt > status.updatedAt
}

/** Compact age like "3s" / "4m" / "2h" / "5d" -- for the dense status/age cells. */
export function formatAgeShort(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
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
