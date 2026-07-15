/**
 * SOTU chip renderers for the Sheaf fleet view: git escalation alerts, the
 * CONTENDED warning pill, the citation-grounding score, and per-branch
 * merge-risk. Split from sheaf-sotu.tsx (strip/stats composition lives there).
 *
 * The CONTENDED badge is the entire passive-collision mechanism, so it is loud
 * (amber, filled). At-risk/unpushed/stalled are loss/rot signals -- also loud.
 */

import type { GitAlert, SheafGrounding, SheafProjectSotu } from '@shared/sheaf-types'

const ALERT_STYLE: Record<GitAlert, { label: string; cls: string; title: string }> = {
  'at-risk': {
    label: 'AT-RISK',
    cls: 'bg-rose-500/15 border-rose-500/40 text-rose-300',
    title: 'A worktree has uncommitted changes and NO live conversation -- abandoned dirt, loss risk',
  },
  unpushed: {
    label: 'UNPUSHED',
    cls: 'bg-amber-500/15 border-amber-500/40 text-amber-300',
    title: 'Local main is ahead of origin/main -- loss risk',
  },
  stalled: {
    label: 'STALLED',
    cls: 'bg-orange-500/15 border-orange-500/40 text-orange-300',
    title: 'An unmerged branch has drifted far behind origin/main -- rotting',
  },
  unmerged: {
    label: 'UNMERGED',
    cls: 'bg-violet-500/15 border-violet-500/40 text-violet-300',
    title: 'A worktree branch carries unintegrated commits with no live conversation -- merge it or it rots',
  },
}

export function AlertChip({ alert }: { alert: GitAlert }) {
  const s = ALERT_STYLE[alert]
  return (
    <span
      className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${s.cls}`}
      title={s.title}
    >
      {s.label}
    </span>
  )
}

export function ContendedPill({ count }: { count: number }) {
  return (
    <span
      className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500 text-amber-950"
      title={`${count} target${count === 1 ? '' : 's'} held by 2+ conversations at once -- coordinate before editing`}
    >
      ⚠ {count} CONTENDED
    </span>
  )
}

export function GroundingChip({ g }: { g: SheafGrounding }) {
  // Bard-lying detector: surface the precision and (most important) the count of
  // cited conversations that are NOT in the input.
  const pct = Math.round(g.precision * 100)
  const lying = g.unknownCited > 0
  return (
    <span
      className={`shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded border ${
        lying ? 'bg-rose-500/15 border-rose-500/40 text-rose-300' : 'border-border/60 text-muted-foreground'
      }`}
      title={`Citation grounding: ${pct}% precision, ${Math.round(g.coverage * 100)}% coverage, ${g.unknownCited} ungrounded of ${g.citedConvs} cited`}
    >
      grounded {pct}%{lying ? ` · ${g.unknownCited} ungrounded` : ''}
    </span>
  )
}

/** A single branch's merge-risk line: conflicts get the loudest treatment. */
export function BranchRisk({ branches }: { branches: SheafProjectSotu['branches'] }) {
  const risky = branches.filter(b => b.integration === 'conflicts' || b.aheadOrigin > 0)
  if (risky.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {risky.slice(0, 8).map(b => {
        const conflicts = b.integration === 'conflicts'
        return (
          <span
            key={b.branch}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
              conflicts ? 'bg-rose-500/15 border-rose-500/40 text-rose-300' : 'border-border/50 text-muted-foreground'
            }`}
            title={
              conflicts
                ? `${b.branch}: merge conflicts vs origin/main${b.conflictFiles?.length ? ` (${b.conflictFiles.length} files)` : ''}`
                : `${b.branch}: ${b.aheadOrigin} ahead / ${b.behindOrigin} behind origin/main (${b.integration})`
            }
          >
            {b.branch} {conflicts ? '⚠ conflicts' : `↑${b.aheadOrigin} ↓${b.behindOrigin}`}
          </span>
        )
      })}
    </div>
  )
}
