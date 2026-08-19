/**
 * Presentation vocabulary for a resolved permission gate: what each outcome is
 * called, what colour it wears, and how the wait reads.
 *
 * Kept apart from the card so the card stays about layout and the wording of an
 * audit line stays in one place.
 */

import type { PermissionOutcome } from '@shared/protocol'

const OUTCOME_LABEL: Record<PermissionOutcome, string> = {
  allowed: 'ALLOWED',
  allowed_always: 'ALWAYS ALLOWED',
  denied: 'DENIED',
  auto: 'AUTO',
  expired: 'EXPIRED',
}

export interface OutcomeStyle {
  card: string
  chip: string
  dot: string
}

const OUTCOME_STYLE: Record<PermissionOutcome, OutcomeStyle> = {
  allowed: {
    card: 'border-emerald-500/40 bg-emerald-500/5',
    chip: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40',
    dot: 'bg-emerald-400',
  },
  allowed_always: {
    card: 'border-blue-500/40 bg-blue-500/5',
    chip: 'bg-blue-500/20 text-blue-200 border-blue-500/40',
    dot: 'bg-blue-400',
  },
  denied: {
    card: 'border-red-500/40 bg-red-500/5',
    chip: 'bg-red-500/20 text-red-200 border-red-500/40',
    dot: 'bg-red-400',
  },
  auto: {
    card: 'border-muted/40 bg-muted/5',
    chip: 'bg-muted/20 text-muted-foreground border-muted/40',
    dot: 'bg-muted-foreground',
  },
  expired: {
    card: 'border-muted/40 bg-muted/5',
    chip: 'bg-muted/20 text-muted-foreground border-muted/40',
    dot: 'bg-muted-foreground',
  },
}

/** The waiting card, before anyone has answered. */
const PENDING_STYLE: OutcomeStyle = {
  card: 'border-amber-500/50 bg-amber-500/5',
  chip: 'bg-amber-500/20 text-amber-200 border-amber-500/40',
  dot: 'bg-amber-400 animate-pulse',
}

/** A gate whose answer we never saw -- answered before receipts existed, or its
 *  decision entry fell outside the loaded window. */
const UNKNOWN_STYLE: OutcomeStyle = {
  card: 'border-muted/30 bg-transparent',
  chip: 'bg-muted/10 text-muted-foreground border-muted/30',
  dot: 'bg-muted-foreground/50',
}

/** How long the gate blocked, in the coarsest unit that still reads true. */
function formatWaited(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

/** How the card presents itself: waiting on a human, resolved, or a gate whose
 *  answer we never saw. Keeps the branching out of the component. */
export function cardAppearance(
  outcome: PermissionOutcome | undefined,
  waiting: boolean,
): { style: OutcomeStyle; label: string } {
  if (outcome) return { style: OUTCOME_STYLE[outcome], label: OUTCOME_LABEL[outcome] }
  if (waiting) return { style: PENDING_STYLE, label: 'PERMISSION' }
  return { style: UNKNOWN_STYLE, label: 'PERMISSION' }
}

/** "allowed by jonas after 12s" -- the one-line audit sentence. */
export function decisionSummary(outcome: PermissionOutcome, decidedBy?: string, waitedMs?: number): string {
  const who = decidedBy ? ` by ${decidedBy}` : ''
  const waited = formatWaited(waitedMs)
  const after = waited ? ` after ${waited}` : ''
  if (outcome === 'auto') return `auto-approved by a standing rule${after}`
  if (outcome === 'expired') return `no answer${after} -- denied automatically`
  return `${OUTCOME_LABEL[outcome].toLowerCase()}${who}${after}`
}
