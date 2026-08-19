/**
 * "LINKED, NOT ADOPTED" -- cards this epic is connected to but does not own.
 *
 * Membership is the `epic:` key and nothing else, and `planEpic` builds the run
 * from the same rollup, so a merely-linked card is not just missing from this
 * view -- THE ENGINE WILL NEVER DISPATCH IT. That is the whole reason this
 * section exists, and it is why the empty state says nothing and the populated
 * one says it out loud.
 *
 * ADOPT writes `epic: <id>`. Deliberately the same one key a human would type,
 * not a softer "linked" relation: a second kind of membership that the DAG
 * ignores would recreate the exact confusion this fixes.
 */

import type { LinkedCard } from '@shared/epic-linked'
import { Check, CornerDownRight } from 'lucide-react'
import { useState } from 'react'
import { cn, haptic } from '@/lib/utils'

const KIND_LABEL: Record<LinkedCard['kind'], string> = {
  direct: 'names this epic',
  family: 'linked via',
}

function Row({
  link,
  epicId,
  busy,
  onOpenCard,
  onAdopt,
}: {
  link: LinkedCard
  epicId: string
  busy: boolean
  onOpenCard: (slug: string) => void
  onAdopt: (slug: string) => void
}) {
  const moving = Boolean(link.ownedBy)

  return (
    <div className="flex items-center gap-2 py-1 border-b border-border-subtle last:border-0">
      <CornerDownRight className="size-3 shrink-0 text-fg-dim" />
      <button
        type="button"
        onClick={() => onOpenCard(link.card.slug)}
        className="min-w-0 flex-1 text-left truncate text-meta text-foreground/85 hover:text-[color:var(--epic-solid)] transition-colors"
      >
        {link.card.title || link.card.slug}
      </button>

      <span className="shrink-0 text-chrome text-fg-dim">
        {KIND_LABEL[link.kind]}
        {link.kind === 'family' && ` ${link.via}`}
      </span>

      {moving && (
        <span className="shrink-0 text-chrome text-idle" title={`Currently owned by ${link.ownedBy}`}>
          in {link.ownedBy}
        </span>
      )}

      <button
        type="button"
        disabled={busy}
        title={
          moving
            ? `MOVE this card out of ${link.ownedBy} and into ${epicId}. It leaves that epic's DAG and joins this one.`
            : `ADOPT: write epic: ${epicId} onto this card. It joins the DAG and becomes dispatchable.`
        }
        onClick={() => {
          haptic('tap')
          onAdopt(link.card.slug)
        }}
        className={cn(
          'shrink-0 px-1.5 py-0.5 text-chrome border transition-colors',
          busy
            ? 'border-border-subtle text-fg-dim cursor-not-allowed'
            : 'border-[color:var(--epic-edge)] text-foreground hover:bg-[color:var(--epic-tint)]',
        )}
      >
        {moving ? 'MOVE' : 'ADOPT'}
      </button>
    </div>
  )
}

export function EpicLinkedSection({
  epicId,
  links,
  onOpenCard,
  onAdopt,
}: {
  epicId: string
  links: LinkedCard[]
  onOpenCard: (slug: string) => void
  /** Writes `epic: epicId` onto the card. Resolves once the board has refreshed. */
  onAdopt: (slug: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string[]>([])

  if (links.length === 0) return null

  async function adopt(slug: string) {
    setBusy(slug)
    await onAdopt(slug)
    setBusy(null)
    // The board refresh drops the row from `links`, but on a slow refresh the
    // row lingers -- a tick beats it looking like the click did nothing.
    setDone(d => [...d, slug])
  }

  const pending = links.filter(l => !done.includes(l.card.slug))
  if (pending.length === 0) return null

  return (
    <div className="px-3.5 pb-4">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-chrome uppercase text-fg-dim">Linked, not adopted</span>
        <span className="text-chrome text-fg-dim">{pending.length}</span>
        {done.length > 0 && (
          <span className="text-chrome text-active flex items-center gap-1">
            <Check className="size-2.5" />
            {done.length} adopted
          </span>
        )}
      </div>

      <p className="text-chrome text-fg-muted mb-2 leading-relaxed">
        These reference the epic or one of its cards, but carry no <code className="text-foreground/70">epic:</code> key
        -- so they are outside the DAG and <b className="text-foreground/70">the engine will never dispatch them</b>.
      </p>

      <div className="border border-border-subtle px-2 py-1">
        {pending.map(link => (
          <Row
            key={link.card.slug}
            link={link}
            epicId={epicId}
            busy={busy === link.card.slug}
            onOpenCard={onOpenCard}
            onAdopt={adopt}
          />
        ))}
      </div>
    </div>
  )
}
