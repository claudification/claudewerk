/**
 * The proposals, grouped by kind, in the order `PROPOSAL_KINDS` declares them.
 *
 * The order is the shared module's, not a local copy: the two fact-derived kinds
 * come first because they are the ones that arrive ticked and therefore the ones
 * a human is actually deciding about at 08:00. The opinion and the marker sit
 * below them, where they belong.
 *
 * A kind with no rows renders NO heading. An empty "Possible duplicates" section
 * reads as "there are none", which is a claim this pipeline is not entitled to
 * make -- no duplicate judge is wired, so nobody looked. The report artifact says
 * that out loud and so does the empty state next door.
 */

import type { Proposal } from '@shared/board-sweep-proposals'
import { PROPOSAL_KINDS } from '@shared/board-sweep-proposals'
import type { BoardApplyOutcome } from '@shared/protocol'
import { MorningReportRow } from './morning-report-row'
import { proposalKey } from './morning-report-selection'

/** One heading per kind. Written for someone skimming with coffee. */
const KIND_HEADING: Readonly<Record<string, string>> = {
  'promote-delivered': 'Delivered -- promote to done',
  'archive-cold': 'Cold in inbox -- archive',
  'flag-duplicate': 'Possible duplicates -- your call',
  'note-delete-at': 'delete_at elapsed -- for a human, never executed here',
}

interface Props {
  proposals: readonly Proposal[]
  selection: ReadonlySet<string>
  outcomes: Record<string, BoardApplyOutcome>
  busy: boolean
  onToggle: (key: string) => void
}

export function MorningReportSections({ proposals, selection, outcomes, busy, onToggle }: Props) {
  return (
    <>
      {PROPOSAL_KINDS.map(kind => {
        const rows = proposals.filter(p => p.kind === kind)
        if (rows.length === 0) return null
        return (
          <section key={kind} className="pt-2 first:pt-0">
            <h3 className="pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {KIND_HEADING[kind] ?? kind} ({rows.length})
            </h3>
            {rows.map(proposal => {
              const key = proposalKey(proposal)
              const outcome = outcomes[key]
              return (
                <MorningReportRow
                  key={key}
                  proposal={proposal}
                  checked={selection.has(key)}
                  // A row that already landed is not offered again -- re-pressing
                  // it would file a second intent for a move that happened.
                  disabled={busy || outcome?.ok === true}
                  outcome={outcome}
                  onToggle={onToggle}
                />
              )
            })}
          </section>
        )
      })}
    </>
  )
}
