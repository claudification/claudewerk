/**
 * PARTIAL RECAP BANNER -- what fell out, and what you can do about it.
 *
 * Shown where a partial recap is actually READ, not just where jobs are
 * listed: the incident that motivated it (recap_zquf15w44ufh) reported "1 of
 * 169 chunk(s) failed" in a widget, while the document itself said nothing, so
 * finding out which conversation was missing meant shelling into the container.
 *
 * The three actions are deliberately labelled with their COST, because that is
 * the whole decision: re-running one casualty on a 169-chunk recap costs a
 * fresh reduce (~$2-4) to recover one conversation, which is sometimes worth it
 * and sometimes absurd. The reader knows which; we do not.
 */

import type { RecapChunkFailure, RecapResolution, RecapResolutionMode } from '@shared/protocol'
import { useState } from 'react'
import { resolveRecap } from '@/components/recap-jobs/recap-wire'
import { haptic } from '@/lib/utils'

interface PartialBannerProps {
  recapId: string
  /** The partial reason (already names the conversations). */
  reason?: string
  failures?: RecapChunkFailure[]
  resolution?: RecapResolution
  /** Resumes already spent, against the cap. */
  resumeCount?: number
  maxResumes?: number
}

const ACTIONS: Array<{ mode: RecapResolutionMode; label: string; cost: string; title: string }> = [
  {
    mode: 'retry_failed',
    label: 'Re-run what failed',
    cost: 'costs a map call each + a full re-synthesis',
    title: 'Re-extract only the failed conversations, then rebuild the document. Nothing already paid for is re-paid.',
  },
  {
    mode: 'synthesize_only',
    label: 'Drop them, rebuild',
    cost: 'costs one re-synthesis',
    title: 'Give up on the failed conversations for good and rebuild the document from what is already extracted.',
  },
  {
    mode: 'accept',
    label: 'Accept as-is',
    cost: 'free',
    title: 'Keep this recap exactly as it is. The missing conversations stay on the record; the recap stops asking.',
  },
]

export function PartialBanner({
  recapId,
  reason,
  failures,
  resolution,
  resumeCount = 0,
  maxResumes = 2,
}: PartialBannerProps) {
  const [sent, setSent] = useState<RecapResolutionMode | null>(null)
  const exhausted = resumeCount >= maxResumes

  function choose(mode: RecapResolutionMode) {
    haptic('tap')
    resolveRecap(recapId, mode)
    setSent(mode)
  }

  return (
    <div className="mx-4 mt-3 rounded border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs">
      <div className="font-semibold text-amber-300">
        Partial recap{resolution ? ` - ${RESOLVED_LABEL[resolution.mode]}` : ''}
      </div>
      {reason && <p className="mt-1 text-amber-100/90">{reason}</p>}
      {failures && failures.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-amber-100/80">
          {failures.map(f => (
            <li key={f.chunkIndex}>
              <span className="opacity-70">{f.outcome === 'salvaged' ? 'partial' : 'lost'}</span>{' '}
              {f.conversations.map(c => c.title || c.id.slice(0, 8)).join(', ') || `chunk ${f.chunkIndex + 1}`}
              {f.outcome === 'salvaged' && f.dropped ? ` (${f.dropped} fact(s) lost)` : ''}
            </li>
          ))}
        </ul>
      )}
      {resolution ? (
        <p className="mt-2 text-amber-100/70">
          Resolved {new Date(resolution.at).toLocaleString()}
          {resolution.by ? ` by ${resolution.by}` : ''}.
        </p>
      ) : sent ? (
        <p className="mt-2 text-amber-100/70">Sent: {RESOLVED_LABEL[sent]}.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {ACTIONS.map(action => {
            // Both re-run paths spend a resume attempt; accept never does, so it
            // must stay available even once the cost guard has kicked in --
            // otherwise a capped recap can never be settled at all.
            const blocked = exhausted && action.mode !== 'accept'
            return (
              <button
                key={action.mode}
                type="button"
                disabled={blocked}
                onClick={() => choose(action.mode)}
                title={blocked ? `Resume cap reached (${resumeCount}/${maxResumes})` : action.title}
                className={`rounded border border-amber-500/50 px-2 py-1 transition-colors ${
                  blocked ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-amber-500/20'
                }`}
              >
                {action.label} <span className="opacity-60">({action.cost})</span>
              </button>
            )
          })}
          <span className="text-amber-100/60">
            {resumeCount}/{maxResumes} resumes used
          </span>
        </div>
      )}
    </div>
  )
}

const RESOLVED_LABEL: Record<RecapResolutionMode, string> = {
  retry_failed: 're-running the failed conversations',
  synthesize_only: 'rebuilt without them',
  accept: 'accepted as-is',
}
