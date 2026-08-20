/**
 * What a hovered card link says. Three states, one frame:
 *   resolving -> header spinner + title skeleton
 *   unknown   -> the id, and why we have nothing (deleted / renamed / elsewhere)
 *   ready     -> status, title, tags, id, dates -- plus the rollup for an epic
 *
 * Everything here reads `CardSummary`, so it renders a GitHub issue or a Jira
 * ticket the day a provider for one exists. No board vocabulary below the seam.
 */

import { useCardLookup } from '@/hooks/use-card-lookup'
import type { CardRef, CardSummary } from '@/lib/cards'
import { CardEpicProgress } from './card-epic-progress'
import {
  CardHoverFooter,
  CardHoverHeader,
  CardHoverSkeleton,
  CardHoverTags,
  HoverFrame,
  HoverSection,
} from './card-hover-parts'

export function CardHoverPanel({ cardRef }: { cardRef: CardRef }) {
  // `deep` = pull what an epic rollup needs. Hover is exactly the moment that
  // cost is justified; rendering a link is not.
  const lookup = useCardLookup(cardRef, true)

  if (lookup.status === 'ready') return <ReadyBody summary={lookup.summary} />
  if (lookup.status === 'unknown') return <UnknownBody id={cardRef.id} />
  return <ResolvingBody id={cardRef.id} />
}

function ReadyBody({ summary }: { summary: CardSummary }) {
  return (
    <HoverFrame>
      <CardHoverHeader summary={summary} />
      <HoverSection>
        {summary.title ? <div className="text-foreground leading-snug">{summary.title}</div> : <CardHoverSkeleton />}
        {/* What the card SAYS, not just what it is called -- the question a
            hover over a card row is actually asking. Clamped: a preview that
            grows to a screenful is a panel, not a preview. */}
        {summary.preview && (
          <div className="mt-1.5 text-[11px] leading-snug text-muted-foreground line-clamp-4 whitespace-pre-wrap break-words">
            {summary.preview}
          </div>
        )}
        {summary.kind === 'epic' && <CardEpicProgress progress={summary.progress} />}
        <CardHoverTags tags={summary.tags} />
      </HoverSection>
      <CardHoverFooter id={summary.ref.id} created={summary.created} updated={summary.updated} />
    </HoverFrame>
  )
}

function ResolvingBody({ id }: { id: string }) {
  return (
    <HoverFrame>
      <HoverSection className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        <span className="card-glyph-spin inline-block" aria-hidden="true">
          ◜
        </span>{' '}
        resolving...
      </HoverSection>
      <HoverSection>
        <CardHoverSkeleton />
      </HoverSection>
      <CardHoverFooter id={id} />
    </HoverFrame>
  )
}

function UnknownBody({ id }: { id: string }) {
  return (
    <HoverFrame>
      <HoverSection className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        <span aria-hidden="true">?</span> not on this board
      </HoverSection>
      <HoverSection className="text-muted-foreground leading-snug">
        No card with this id in the current project. Deleted, renamed, or a different project.
      </HoverSection>
      <CardHoverFooter id={id} />
    </HoverFrame>
  )
}
