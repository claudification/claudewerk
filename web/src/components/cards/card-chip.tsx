/**
 * A board card, inline, wherever the panel holds a card PATH but no markdown.
 *
 * A `Write .rclaude/project/cards/wall-time-cursor.md` tool line names a file,
 * but that file is a card: it has a lane, a title and an editor. Rendering the
 * filename throws all three away, so the tool lines render this instead.
 *
 * This is the React twin of the `a.file-link-card` anchor the markdown renderer
 * emits -- same glyph, same hover panel, same click target, same RIGHT-click
 * menu. Two implementations exist because that one is a raw HTML string painted
 * imperatively and this one is a component; they share `cardGlyph()` and
 * `openCardMenu()` so they cannot drift.
 *
 * SCOPE is ambient (the selected conversation's project, resolved inside the
 * provider), which is what every other transcript surface already does. The
 * prop is here for the day a transcript is rendered for a conversation that is
 * not the selected one.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useCardLookup } from '@/hooks/use-card-lookup'
import { CARD_STATE_STYLE, type CardRef, cardGlyph, matchCardHref } from '@/lib/cards'
import { cn } from '@/lib/utils'
import { closeCardHover, closeCardHoverFor, openCardHover } from '../card-hover/card-hover-bus'
import { openProjectCard } from '../conversation-detail/project-card-verbs'
import { openCardMenu } from './card-menu-bus'

export function CardChip({ path, scope, fallback }: { path: string; scope?: string; fallback?: string }) {
  const ref = useMemo<CardRef | null>(() => {
    const hit = matchCardHref(path)
    if (!hit) return null
    return scope ? { ...hit, scope } : hit
  }, [path, scope])

  // Shallow: an epic rollup is a whole-board hydration, and a transcript can
  // hold dozens of these. The hover panel pays for depth, a row does not.
  const lookup = useCardLookup(ref)
  const anchor = useRef<HTMLButtonElement>(null)
  useEffect(() => () => closeCardHoverFor(anchor.current), [])

  if (!ref) return <>{fallback ?? path}</>

  const view = cardGlyph(lookup)
  const title = lookup.status === 'ready' ? lookup.summary.title : undefined

  return (
    <button
      ref={anchor}
      type="button"
      title={path}
      data-card-state={view.dataState}
      data-card-kind={view.kind}
      className="inline-flex items-baseline gap-1 min-w-0 max-w-full text-left text-violet-300 hover:text-violet-200 decoration-dotted underline-offset-2 hover:underline"
      onClick={e => {
        // The row itself toggles its output pane -- opening a card must not.
        e.preventDefault()
        e.stopPropagation()
        openProjectCard(ref.id)
      }}
      onContextMenu={e => {
        // A chip lives inside a chat bubble that already owns right-click (see
        // fork-point-menu). The INNER menu wins, and it takes both lines -- the
        // markdown renderer's twin handler carries the full note on why.
        e.preventDefault()
        e.stopPropagation()
        closeCardHover()
        openCardMenu({ ref, path, x: e.clientX, y: e.clientY })
      }}
      onMouseEnter={e => openCardHover(ref, e.currentTarget)}
      onMouseLeave={closeCardHover}
      onFocus={e => openCardHover(ref, e.currentTarget)}
      onBlur={closeCardHover}
    >
      <span
        aria-hidden="true"
        className={cn(
          'shrink-0 text-[0.85em]',
          CARD_STATE_STYLE[view.state].text,
          view.dataState === 'resolving' && 'card-glyph-spin',
        )}
      >
        {view.glyph}
      </span>
      <span className="truncate">{title ?? ref.id}</span>
    </button>
  )
}
