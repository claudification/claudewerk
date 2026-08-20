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

/**
 * The three states this button has, each owning its own word, tooltip and skin.
 *
 * A DEAD BUTTON MUST SAY SO IN INK -- `dead` used to render the word `PIN` and
 * explain itself only in a `title`, which is a hover, and there is no hover on
 * the tablet this board is mostly read on. A click that could never work was
 * indistinguishable from a pin that did not persist, which is what got reported
 * on 2026-08-20.
 */
const FACES = {
  dead: {
    label: 'NO CARD',
    title: 'This epic has no card of its own -- there is nothing to pin the key onto',
    skin: 'border-border text-fg-dim cursor-not-allowed',
  },
  pinned: {
    label: 'PINNED',
    title: `Pinned to THE WALL (\`${WALL_PINNED_KEY}: true\` on this card). Click to stop watching it there.`,
    skin: 'border-[color:var(--epic-edge)] bg-[color:var(--epic-tint)] text-[color:var(--epic-solid)]',
  },
  unpinned: {
    label: 'PIN',
    title: `Watch this epic on THE WALL: progress, and every card that is not closed. Writes \`${WALL_PINNED_KEY}\` onto the card, so it survives a restart and an agent can grep for it.`,
    skin: 'border-border text-fg-muted hover:text-foreground hover:bg-muted/30',
  },
} as const

/**
 * DID THE CARD ACTUALLY TAKE THE PIN? A sentinel bundle older than A8 accepts
 * the `update`, ignores `wallPinned`, and answers ok -- the button then showed
 * PINNED over a card with nothing written on it, and the wall showed nothing,
 * forever. So believe the card in the reply, not the `ok`.
 *
 * Unpinning DELETES the key, so a missing `wallPinned` on an unpin is success.
 */
function wroteThePin(reply: Record<string, unknown>, next: boolean): boolean {
  if (!reply.ok) return false
  const task = reply.task as { wallPinned?: boolean } | undefined
  if (!task) return true
  if (task.wallPinned === next) return true
  return next === false && task.wallPinned === undefined
}

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

  const face = FACES[disabled ? 'dead' : pinned ? 'pinned' : 'unpinned']

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={pinned}
      title={face.title}
      onClick={async () => {
        if (disabled) return
        haptic('tap')
        const next = !pinned
        setPending(next)
        const reply = await sendBoardOp(project, 'update', { slug: rollup.epicId, patch: { wallPinned: next } })
        // A write that failed -- or succeeded WITHOUT APPLYING THE KEY -- must
        // not leave the button lying about the card. See `wroteThePin`.
        if (!wroteThePin(reply, next)) setPending(null)
      }}
      className={cn(
        'shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono border transition-colors',
        face.skin,
      )}
    >
      {face === FACES.pinned ? <Pin className="size-2.5 fill-current" /> : <PinOff className="size-2.5" />}
      {face.label}
    </button>
  )
}
