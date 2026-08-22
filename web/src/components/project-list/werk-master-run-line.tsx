/**
 * THE RUN, on the werk-master's row -- generation, load, beat age, epic progress.
 *
 * A werk-master is the one row where "what is this conversation" is not the useful
 * question. The useful question is what its RUN is doing, and that answer lived
 * only in a separate window.
 *
 * THE STATE WORD COMES FROM `runVitality()`, NEVER FROM `.status`. That field is
 * an INTENT the sentinel writes once and nothing writes back down: on
 * 2026-08-20 it read `running` for hours over a run whose werk-master conversation
 * had ended, with `armed=false` and zero seats alive. `runVitality` is the one
 * derivation the header badge, the wall's A7 pane and the werk-master window all
 * share; feeding this row off the raw field would ship a fourth opinion about
 * what "running" means.
 */

import { runVitality } from '@shared/epic-vitality'
import { useCardLookup } from '@/hooks/use-card-lookup'
import { useEpicRun } from '@/hooks/use-epic-run'
import { projectBoardCardRef } from '@/lib/cards'
import { formatAgeShort } from '@/lib/status-style'
import type { Conversation } from '@/lib/types'
import { cn, parseWorktreeUri } from '@/lib/utils'
import { VITALITY_TONE } from './werk-master-vitality-tone'

/** Progress over an epic's child cards, straight off the board the panel already
 *  holds. Deliberately NOT a broker fold: `provider-project-board` already rolls
 *  a card's children up and memoises it on the board version, so the count is
 *  free here and cannot disagree with what the board itself shows.
 *
 *  `deep` triggers a whole-board hydration, which a dense transcript could not
 *  afford -- but a werk-master row is at most one or two per project, and the
 *  board is usually already hydrated for the selected project. */
function EpicProgress({ epicId, scope }: { epicId: string; scope: string }) {
  const lookup = useCardLookup(projectBoardCardRef(epicId, scope), true)
  const progress = lookup.status === 'ready' ? lookup.summary.progress : undefined
  const title = lookup.status === 'ready' ? lookup.summary.title : undefined
  if (!progress || progress.total === 0) return null

  return (
    <div className="mt-0.5 pl-4 flex items-center gap-1.5 text-[9px] min-w-0">
      <span className="text-fg-faint shrink-0" aria-hidden="true">
        {'▪'}
      </span>
      <span className="truncate text-fg-muted">{title ?? epicId}</span>
      <span className="font-mono tabular-nums text-fg-dim shrink-0">
        {progress.done}/{progress.total}
      </span>
      <div className="flex-1 h-1 min-w-6 bg-muted/50 rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-amber-400/70" style={{ width: `${progress.pct ?? 0}%` }} />
      </div>
    </div>
  )
}

export function WerkMasterRunLine({ conversation }: { conversation: Conversation }) {
  const epicId = conversation.epic?.epicId
  const run = useEpicRun(epicId)
  if (!epicId || !run) return null

  const view = runVitality(run)
  const scope = parseWorktreeUri(conversation.project)?.parentUri ?? conversation.project

  // Every count is a fact about the run, dot-separated like the row's own meta
  // footer so the werk-master reads as a richer version of an ordinary row rather
  // than a different kind of object.
  const facts = [
    `gen ${run.gen}/${run.maxGens}`,
    `${run.inFlight} in flight`,
    run.lastBeatAt ? `beat ${formatAgeShort(Date.parse(run.lastBeatAt))} ago` : 'never beaten',
  ]

  return (
    <>
      <div className="mt-0.5 pl-4 flex items-center gap-1.5 text-[9px]">
        <span
          className={cn('font-bold', VITALITY_TONE[view.vitality], view.breathing && 'animate-pulse')}
          title={view.why}
        >
          {view.label}
        </span>
        {facts.map(fact => (
          <span key={fact} className="contents">
            <span className="text-fg-faint">·</span>
            <span className="text-fg-dim font-mono tabular-nums">{fact}</span>
          </span>
        ))}
      </div>
      <EpicProgress epicId={epicId} scope={scope} />
    </>
  )
}
