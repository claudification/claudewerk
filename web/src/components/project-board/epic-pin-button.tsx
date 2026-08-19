/**
 * PIN TO WALL -- put this epic on the watchlist, or take it off.
 *
 * A TOGGLE that reads as STATE once set (`Pinned`, filled glyph), not as an
 * action you could perform twice. The write goes onto the epic's own card as
 * `wall_pinned: true` (see `src/shared/wall-pin.ts` for why there and not in
 * panel preferences), so it survives a broker restart and THE WALL's A8 pane
 * finds it by reading the board it already reads.
 *
 * The pin is the only half of this that lives on the board. Everything about
 * how a pinned epic RENDERS lives on the wall.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { WALL_PINNED_KEY } from '@shared/wall-pin'
import { Pin, PinOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { sendBoardOp } from '@/hooks/use-project-tasks'
import { cn, haptic } from '@/lib/utils'
import { useAmbientProject } from './use-ambient-project'

export function EpicPinButton({ rollup }: { rollup: EpicRollup }) {
  const project = useAmbientProject()
  const stored = rollup.card?.wallPinned === true

  // OPTIMISTIC, and cleared the moment the board catches up. The write lands on
  // disk through the sentinel and comes back as a `project_changed` push, which
  // is fast but not instant -- a toggle that sits on its old label until a
  // round trip completes reads as a click that did nothing.
  const [pending, setPending] = useState<boolean | null>(null)
  useEffect(() => setPending(null), [stored])
  const pinned = pending ?? stored

  // No card on the board means nothing to write the key onto: a child can name
  // an epic id that has no card (`EpicRollup.card` is nullable for exactly that
  // reason), and pinning it would silently create nothing.
  const disabled = !project || !rollup.card

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={pinned}
      title={
        disabled
          ? 'This epic has no card of its own -- there is nothing to pin the key onto'
          : pinned
            ? `Pinned to THE WALL (\`${WALL_PINNED_KEY}: true\` on this card). Click to stop watching it there.`
            : `Watch this epic on THE WALL: progress, and every card that is not closed. Writes \`${WALL_PINNED_KEY}\` onto the card, so it survives a restart and an agent can grep for it.`
      }
      onClick={async () => {
        if (disabled) return
        haptic('tap')
        const next = !pinned
        setPending(next)
        const reply = await sendBoardOp(project, 'update', { slug: rollup.epicId, patch: { wallPinned: next } })
        // A failed write must not leave the button lying about the card.
        if (!reply.ok) setPending(null)
      }}
      className={cn(
        'shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono border transition-colors',
        disabled
          ? 'border-border text-fg-dim cursor-not-allowed'
          : pinned
            ? 'border-[color:var(--epic-edge)] bg-[color:var(--epic-tint)] text-[color:var(--epic-solid)]'
            : 'border-border text-fg-muted hover:text-foreground hover:bg-muted/30',
      )}
    >
      {pinned ? <Pin className="size-2.5 fill-current" /> : <PinOff className="size-2.5" />}
      {pinned ? 'PINNED' : 'PIN'}
    </button>
  )
}
