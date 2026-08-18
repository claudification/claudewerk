/**
 * One epic, read in full.
 *
 * This is where everything the swimlane header used to force into a list now
 * lives: the body excerpt, the tags, the refs, the actions and the child table.
 * The difference is that only ONE epic renders it at a time, so it can afford
 * to be generous instead of being repeated seven times at 10px.
 *
 * The child table and row are unchanged -- they were already the right shape,
 * they just moved.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import type { LinkedCard } from '@shared/epic-linked'
import type { TaskMode } from '@shared/task-modes'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { EpicChildTable } from './epic-child-table'
import { EpicDetailHeader, type EpicRunHandler } from './epic-detail-header'
import { EpicLinkedSection } from './epic-linked-section'

function excerpt(text: string | undefined, limit = 320): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat
}

/** Children that cannot start. The one fact that changes what someone does next. */
function blockedCount(rollup: EpicRollup): number {
  return rollup.children.filter(c => c.waitingOn.length > 0 && c.bucket !== 'done').length
}

function MetaLine({ rollup }: { rollup: EpicRollup }) {
  const card = rollup.card
  const tags = (card?.tags ?? []).filter(t => t !== 'epic')
  const refs = card?.refs ?? []
  if (tags.length === 0 && refs.length === 0) return null

  return (
    <div className="px-3.5 pb-2.5 flex items-center gap-x-4 gap-y-1 flex-wrap font-mono text-chrome">
      <span className="text-muted-foreground/60">{rollup.epicId}</span>
      {tags.length > 0 && (
        <span className="text-muted-foreground/90">
          <span className="text-muted-foreground/60">tags </span>
          {tags.join(' ')}
        </span>
      )}
      {refs.length > 0 && (
        <span className="text-muted-foreground/90 truncate">
          <span className="text-muted-foreground/60">refs </span>
          {refs.join(' · ')}
        </span>
      )}
    </div>
  )
}

export function EpicDetailPane({
  rollup,
  onOpenCard,
  onWorkOnEpic,
  onEpicMode,
  onRunEpic,
  onBack,
  links = [],
  onAdopt,
}: {
  rollup: EpicRollup
  onOpenCard: (slug: string) => void
  onWorkOnEpic: (epicId: string) => void
  onEpicMode: (epicId: string, mode: TaskMode) => void
  onRunEpic: EpicRunHandler
  /** Mobile only: the index is a separate screen there, so the pane needs a way home. */
  onBack?: () => void
  /** Cards connected to this epic that it does not own. Empty renders nothing. */
  links?: LinkedCard[]
  /** Writes `epic: <id>` onto a card. Absent => the section stays hidden, so a
   *  caller with no write path cannot offer a button that does nothing. */
  onAdopt?: (slug: string) => Promise<void>
}) {
  const body = excerpt(rollup.card?.bodyPreview)

  return (
    <div style={epicColorVars(epicHue(rollup.epicId, rollup.card?.color))} className="flex-1 min-h-0 flex flex-col">
      <EpicDetailHeader
        rollup={rollup}
        blocked={blockedCount(rollup)}
        onOpenCard={onOpenCard}
        onWorkOnEpic={onWorkOnEpic}
        onEpicMode={onEpicMode}
        onRunEpic={onRunEpic}
        onBack={onBack}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {body && <p className="px-3.5 py-2.5 font-mono text-read text-muted-foreground/95 leading-relaxed">{body}</p>}

        <MetaLine rollup={rollup} />

        <div className="px-3.5 pb-4">
          {rollup.children.length > 0 ? (
            <EpicChildTable rows={rollup.children} onOpenCard={onOpenCard} />
          ) : (
            <p className="font-mono text-meta text-muted-foreground/70">
              Nothing points at this epic yet. Put <code className="text-foreground">epic: {rollup.epicId}</code> in a
              card's frontmatter to adopt it.
            </p>
          )}
          {rollup.dropped > 0 && (
            <p className="mt-2 font-mono text-chrome text-muted-foreground/60">
              ⊘ {rollup.dropped} dropped -- excluded from the percentage
            </p>
          )}
        </div>

        {onAdopt && (
          <EpicLinkedSection epicId={rollup.epicId} links={links} onOpenCard={onOpenCard} onAdopt={onAdopt} />
        )}
      </div>
    </div>
  )
}
