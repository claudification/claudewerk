import type { NightshiftQueueItem } from '@shared/nightshift-types'
import { X } from 'lucide-react'

function FeasibilityBadge({ feasibility }: { feasibility?: string }) {
  if (!feasibility) return null
  const color =
    feasibility === 'feasible'
      ? 'text-green-400 border-green-800'
      : feasibility === 'uncertain'
        ? 'text-yellow-400 border-yellow-800'
        : 'text-red-400 border-red-800'
  return <span className={`text-[10px] font-mono uppercase border rounded px-1 py-0.5 ${color}`}>{feasibility}</span>
}

function RiskBadge({ risk }: { risk?: string }) {
  if (!risk) return null
  const color = risk === 'low' ? 'text-green-400' : risk === 'medium' ? 'text-yellow-400' : 'text-red-400'
  return <span className={`text-[10px] font-mono uppercase ${color}`}>{risk} risk</span>
}

/**
 * `onRemove` is OPTIONAL on purpose. The leftovers block still passes it -- those
 * entries are files and removing one deletes a file. A card on tonight's list is
 * not: it is a board card carrying `#nightshift`, and taking it off the list
 * means untagging the card, which is a board write this pane deliberately does
 * not own. No button beats a button that reports success without changing what
 * runs.
 */
export function QueueCard({
  item,
  onRemove,
  busy,
}: {
  item: NightshiftQueueItem
  onRemove?: () => void
  busy?: boolean
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-sm leading-snug">{item.title}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-mono text-muted-foreground">#{item.id}</span>
          {onRemove && (
            <button
              type="button"
              disabled={busy}
              onClick={onRemove}
              title="Remove from the nightshift queue"
              className="text-muted-foreground hover:text-red-300 transition-colors disabled:opacity-40"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <FeasibilityBadge feasibility={item.feasibility} />
        <RiskBadge risk={item.risk} />
        {item.source === 'board' && (
          <span
            className="text-[10px] font-mono text-sky-400/80"
            title={item.boardRef ? `board: ${item.boardRef}` : undefined}
          >
            {/* The card id, not just "from board": under the tag the card IS the
                item, so the id is the thing a reader needs to go look at. */}
            {item.boardRef ?? 'from board'}
          </span>
        )}
      </div>

      {item.acceptance && <p className="text-xs text-muted-foreground italic">{item.acceptance}</p>}
    </div>
  )
}
