/**
 * THE PROMISE LEDGER on the project page -- what this board claims was built,
 * and whether a commit on main agrees.
 *
 * THE LOUD TABLE COMES FIRST AND IT IS NOT COLLAPSIBLE. Every other section on
 * this panel folds away (`ProjectCommitsSection`, the recaps, the README) and
 * that is right for a list of things that went fine. This one is an accusation:
 * a card filed as finished with nothing standing behind it. Giving it a collapse
 * chevron would make "hide the thing I did not do" a one-click affordance sitting
 * right next to the thing.
 *
 * WHAT IT DOES NOT DO IS FILTER BY PERMISSION. The rows arrive already redacted
 * or already withheld -- the sentinel owns the files and the broker owns the
 * `files:read` check on the way through. A share viewer who must not see shas
 * gets a response without them; this component renders what it is given and
 * makes no decision of its own about who deserves to see a commit hash. A
 * client-side gate here would be a second answer, and the one that drifted would
 * be the one leaking.
 */

import { isBrokenPromise, isInferred, type PromiseRow } from '@shared/promise-ledger'
import { usePromiseLedger } from '@/hooks/use-promise-ledger'
import { brokenReason, verdictFace, verdictTally } from '@/lib/promise-verdict'
import { haptic } from '@/lib/utils'
import { openProjectCard } from './project-card-verbs'

/** Semantic board tokens, not raw tailwind -- the panel's palette, keyed by the
 *  shared tone so the wall and this page can never disagree about severity. */
const TONE_TEXT: Record<string, string> = {
  delivered: 'text-active',
  broken: 'text-destructive',
  unknown: 'text-info',
  unclaimed: 'text-fg-muted',
  historic: 'text-fg-dim',
}

export function ProjectPromisesSection({ projectUri }: { projectUri: string }) {
  // The card editor overlay is already mounted beside this panel, so opening a
  // card is a store write and not a modal -- `project-card-verbs.ts` owns that.
  const { byProject, loading, refused } = usePromiseLedger([projectUri])
  const entry = byProject.get(projectUri)
  const ledger = entry?.ledger

  // Never asked yet, or the sentinel does not know the op. Both render NOTHING
  // rather than an empty ledger: "this board has no broken promises" is a claim,
  // and it is one we have no evidence for until somebody answers.
  if (loading || !ledger) {
    return refused === null ? null : <p className="text-[10px] text-fg-dim px-1">promise ledger: {refused}</p>
  }

  const broken = ledger.rows.filter(isBrokenPromise)
  const promised = ledger.rows.filter(row => row.closes.length > 0)
  if (broken.length === 0 && promised.length === 0) return null

  return (
    <div className="space-y-2">
      <BrokenSection rows={broken} scanned={ledger.scanned} />
      <TallyLine rows={ledger.rows} resolverBase={ledger.resolverBase} />
    </div>
  )
}

function BrokenSection({ rows, scanned }: { rows: PromiseRow[]; scanned: number }) {
  if (rows.length === 0) return null

  return (
    <div className="space-y-1 border border-destructive/60 p-2">
      <div className="text-[10px] text-destructive font-bold uppercase tracking-wider flex items-center gap-2">
        <span>Filed as finished with NO commit behind it ({rows.length})</span>
        <span className="flex-1 h-px bg-destructive/30" />
        {/* The denominator, so the count is a proportion and not a bare scare
            number. `12 of 372` is a different sentence from `12`. */}
        <span className="font-normal text-fg-dim normal-case tracking-normal">of {scanned} cards</span>
      </div>
      {rows.map(row => (
        <BrokenRow key={row.id} row={row} />
      ))}
    </div>
  )
}

function BrokenRow({ row }: { row: PromiseRow }) {
  const face = verdictFace(row.verdict)
  return (
    <button
      type="button"
      className="w-full text-left flex items-baseline gap-2 px-1 py-0.5 hover:bg-surface-raised transition-colors"
      onClick={() => {
        haptic('tap')
        openProjectCard(row.id)
      }}
    >
      <span aria-hidden="true" className={`text-[10px] shrink-0 ${TONE_TEXT[face.tone]}`}>
        {face.glyph}
      </span>
      <span className="text-[11px] font-mono text-fg-muted truncate shrink-0 max-w-[45%]">{row.id}</span>
      <span className="text-[10px] text-muted-foreground truncate flex-1">{brokenReason(row.verdict)}</span>
      <span className="text-[10px] font-mono text-destructive shrink-0">{row.status}</span>
    </button>
  )
}

/**
 * The whole board in one line: how many of each verdict, worst first.
 *
 * `resolverBase` is printed when it is missing, and only then. A ledger whose
 * every row reads `could not verify` because the repo has no `main` branch looks
 * identical to one whose shas are individually unresolvable, and those call for
 * completely different reactions. Saying "no main branch to compare against"
 * once is cheaper than five identical grey pills that explain nothing.
 */
function TallyLine({ rows, resolverBase }: { rows: PromiseRow[]; resolverBase: string | null }) {
  const tally = verdictTally(rows.map(row => row.verdict))
  const inferred = rows.filter(isInferred).length
  if (tally.length === 0) return null

  return (
    <div className="flex items-baseline gap-3 px-1 flex-wrap">
      {tally.map(({ verdict, count }) => {
        const face = verdictFace(verdict)
        return (
          <span key={verdict} className={`text-[10px] font-mono ${TONE_TEXT[face.tone]}`}>
            <span aria-hidden="true">{face.glyph} </span>
            {count} {face.long}
          </span>
        )
      })}
      {/* SAID OUT LOUD, next to the count it qualifies. A `delivered` row whose
          sha a script reconstructed is still delivered -- the commit is real and
          it is on main -- but a reader who assumes somebody PROMISED it is
          reading more into the number than it says. */}
      {inferred > 0 && (
        <span className="text-[10px] font-mono text-fg-dim">
          <span aria-hidden="true">~ </span>
          {inferred} reconstructed by backfill, not promised
        </span>
      )}
      {resolverBase === null && (
        <span className="text-[10px] text-info">no main branch here -- nothing could be checked against it</span>
      )}
    </div>
  )
}
