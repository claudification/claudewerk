/**
 * One proposed action: a checkbox, the card it is about, and the sweep's own
 * one-line reason.
 *
 * A `note-delete-at` row HAS NO CHECKBOX AT ALL (F18). Not a disabled one --
 * absent. A greyed box says "not right now"; this kind is never executed from
 * here, in this version or any version that keeps F18, and the row exists purely
 * to be SEEN. It is rendered as a marker for a human, which is what it is.
 *
 * After a press, a row shows what `apply` reported back. That is the only thing
 * that ever writes an outcome onto a row: the surface never colours a row green
 * because it asked for something.
 */

import type { Proposal } from '@shared/board-sweep-proposals'
import type { BoardApplyOutcome } from '@shared/protocol'
import { AlertTriangle, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isTickable, proposalKey } from './morning-report-selection'

interface Props {
  proposal: Proposal
  checked: boolean
  disabled: boolean
  outcome?: BoardApplyOutcome
  onToggle: (key: string) => void
}

/** The lane change a row promises, for the rows that carry one. */
function transition(p: Proposal): string | null {
  if (p.kind === 'promote-delivered' || p.kind === 'archive-cold') return `${p.from} -> ${p.to}`
  return null
}

function OutcomeBadge({ outcome }: { outcome: BoardApplyOutcome }) {
  if (outcome.ok) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-500">
        <Check className="size-3" />
        {outcome.status ? `now \`${outcome.status}\`` : 'done'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-destructive">
      <AlertTriangle className="size-3" />
      {outcome.error ?? 'failed'}
    </span>
  )
}

export function MorningReportRow({ proposal, checked, disabled, outcome, onToggle }: Props) {
  const key = proposalKey(proposal)
  const tickable = isTickable(proposal)
  const lane = transition(proposal)

  return (
    <div
      className={cn(
        'flex items-start gap-3 border-b border-border px-1 py-2 last:border-0',
        !tickable && 'opacity-70',
        outcome?.ok && 'opacity-60',
      )}
    >
      {tickable ? (
        <input
          type="checkbox"
          className="mt-0.5 size-3.5 accent-primary disabled:cursor-not-allowed"
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle(key)}
          aria-label={`${proposal.kind} ${proposal.card}`}
        />
      ) : (
        // The deliberate blank where a checkbox would be, so the rows still line
        // up and the absence reads as a decision rather than a rendering bug.
        <span className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs font-medium">{proposal.card}</code>
          {lane && <span className="font-mono text-[10px] text-muted-foreground">{lane}</span>}
          {proposal.kind === 'flag-duplicate' && (
            <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
              opinion {Math.round(proposal.confidence * 100)}%
            </span>
          )}
          {!tickable && (
            <span className="rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
              for a human
            </span>
          )}
          {outcome && <OutcomeBadge outcome={outcome} />}
        </div>
        <div className="text-[10px] leading-relaxed text-muted-foreground">{proposal.detail}</div>
      </div>
    </div>
  )
}
