/**
 * The head of the detail pane: who this epic is, how it stands, what you can
 * do about it.
 *
 * The four numbers are on the `loud` tier and labelled underneath. They used to
 * be a row of 9px glyph-and-word pairs (`● 0 done  ◐ 0 moving  ○ 13 open`),
 * which is four facts whispered at the same volume as the refs line.
 */

import type { EpicRollup } from '@shared/epic-cards'
import type { EpicRunState } from '@/lib/epic-run-api'

/** What the RUN button hands back: which epic, its current run (if any), and the
 *  project it belongs to -- the button is the one component that knows all three. */
export type EpicRunHandler = (epicId: string, run: EpicRunState | null, project: string | null) => void

import type { TaskMode } from '@shared/task-modes'
import { ArrowLeft } from 'lucide-react'
import { cn, haptic } from '@/lib/utils'
import { EpicMarkBadge } from './epic-mark-badge'
import { EpicModeButtons } from './epic-mode-buttons'
import { EpicRunButton } from './epic-run-button'
import { EpicWorkButton } from './epic-work-button'

function Stat({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className={cn('text-loud tabular-nums leading-none', tone)}>{value}</span>
      <span className="text-chrome text-fg-dim">{label}</span>
    </span>
  )
}

export function EpicDetailHeader({
  rollup,
  blocked,
  onOpenCard,
  onWorkOnEpic,
  onEpicMode,
  onRunEpic,
  onBack,
}: {
  rollup: EpicRollup
  blocked: number
  onOpenCard: (slug: string) => void
  onWorkOnEpic: (epicId: string) => void
  onEpicMode: (epicId: string, mode: TaskMode) => void
  /** RUN: hand the whole epic to the engine. Distinct verb from LAUNCH. */
  onRunEpic: EpicRunHandler
  onBack?: () => void
}) {
  const title = rollup.card?.title ?? rollup.epicId

  return (
    <div className="px-3.5 py-3 border-b border-border border-l-[3px] border-l-[color:var(--epic-solid)] bg-[color:var(--epic-tint)] shrink-0">
      <div className="flex items-start gap-2.5">
        {onBack && (
          <button
            type="button"
            aria-label="Back to the epic index"
            onClick={() => {
              haptic('tap')
              onBack()
            }}
            // Desktop shows index and pane side by side, so there is nowhere to go back TO.
            className="shrink-0 mt-0.5 text-fg-muted hover:text-foreground transition-colors md:hidden"
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <EpicMarkBadge epicId={rollup.epicId} variant="solid" className="mt-0.5" />
        <button
          type="button"
          onClick={() => onOpenCard(rollup.epicId)}
          className="text-loud font-mono text-left text-foreground hover:text-[color:var(--epic-solid)] transition-colors"
        >
          {title}
        </button>
      </div>

      <div className="flex items-end gap-5 mt-3 flex-wrap">
        <Stat value={rollup.done} label="DONE" tone="text-active" />
        <Stat value={rollup.notStarted + rollup.inProgress} label="OPEN" tone="text-foreground" />
        {blocked > 0 && <Stat value={blocked} label="BLOCKED" tone="text-event-prompt" />}
        {rollup.dropped > 0 && <Stat value={rollup.dropped} label="DROPPED" tone="text-fg-muted" />}
        <span className="flex items-center gap-1.5 ml-auto">
          <EpicRunButton rollup={rollup} onOpenDialog={onRunEpic} />
          <EpicWorkButton rollup={rollup} onWork={onWorkOnEpic} />
          <EpicModeButtons rollup={rollup} onMode={onEpicMode} />
        </span>
      </div>
    </div>
  )
}
