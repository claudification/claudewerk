/**
 * THE COMMIT DETAIL, INSIDE THE WALL.
 *
 * W4 makes every wall row drive the MAIN window. A commit row is the one place
 * that is wrong (Jonas, 2026-08-20): the wall sits on a second monitor so the
 * main window can stay on whatever it was doing, and a commit's message, files
 * and diffstat are a READ, not a place you go and work.
 *
 * THE SURFACE IS AN OVERLAY SHEET, not a rail and not a pane that expands.
 * Three shapes were on the table and the v1 layout is HARD (epic rule 6):
 *   - a right-hand rail in the grid would permanently take a column's width from
 *     the other twelve panes, for a panel that is shut most of the time;
 *   - a pane expanding in place would reflow its column every click, which is
 *     the layout engine v1 explicitly is not;
 *   - an overlay costs the grid NOTHING when closed, and when open it covers the
 *     panes rather than resizing them.
 * So: absolutely positioned inside `.wall-root`, right-anchored, over the grid.
 *
 * IT LIVES IN THE WALL'S OWN DOM, and that is the whole mechanism. A detached
 * wall portals `.wall-root` into the popup while its React tree stays in the
 * opener, so a panel rendered here appears in the POPUP -- where the click was
 * -- while a main-window modal would have opened behind it and raised the
 * dashboard over the top.
 */

import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { closeCardHover } from '@/components/card-hover/card-hover-bus'
import { CommitDetailView } from '@/components/commits/commit-detail-view'
import type { CommitDetail } from '@/components/commits/use-commit-detail'
import { useWallCommitDetail } from './use-wall-commit-detail'
import { closeWallDetail, useWallDetail } from './wall-detail-store'
import { useWallStore } from './wall-state'

export function WallDetail() {
  const hash = useWallDetail(s => s.hash)
  const ambient = useWallStore(s => s.ambient)

  // AMBIENT CLOSES IT. Ambient is the wall read from across a room with no
  // cursor: nothing there can open a detail, and a sheet left over from before
  // would cover a third of the panes with nobody able to dismiss it -- ambient
  // eats Escape in the capture phase to get itself out of fullscreen.
  useEffect(() => {
    if (ambient) closeWallDetail()
  }, [ambient])

  if (!hash || ambient) return null
  return <WallCommitDetail hash={hash} />
}

function WallCommitDetail({ hash }: { hash: string }) {
  const { detail, stale } = useWallCommitDetail(hash)
  const wrapRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Take the panel, and hand focus back where it came from on the way out --
  // which is the river row, so the next Enter re-opens what you were reading
  // instead of dropping you at the top of the document.
  useEffect(() => {
    const wrap = wrapRef.current
    const panel = panelRef.current
    if (!wrap || !panel) return
    const returnTo = panel.ownerDocument.activeElement as HTMLElement | null
    // A preview under the pointer would float over the panel that just replaced
    // it, saying the same thing in a smaller box.
    closeCardHover()
    panel.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeWallDetail()
    }
    // ON THE ELEMENT, NOT THE DOCUMENT. Detaching the wall MOVES this subtree
    // into the popup's document, and a listener bound to the document it was
    // born in goes deaf the moment you pop the wall out -- an open panel you
    // cannot Escape, on the monitor you are actually looking at. The scrim
    // covers the grid and the panel holds focus, so everything the keyboard can
    // reach while this is open is inside here anyway.
    wrap.addEventListener('keydown', onKey)
    return () => {
      wrap.removeEventListener('keydown', onKey)
      if (returnTo?.isConnected) returnTo.focus()
    }
  }, [])

  return (
    <div className="wall-detail" ref={wrapRef}>
      {/* Click-away. A real button so the keyboard and the screen reader get the
          same exit the pointer does. */}
      <button
        type="button"
        className="wall-detail-scrim"
        aria-label="Close the commit detail"
        onClick={closeWallDetail}
      />
      <section className="wall-detail-panel" ref={panelRef} tabIndex={-1} aria-label="Commit detail">
        <header className="wall-pane-head">
          <h2 className="wall-pane-title">COMMIT</h2>
          <span className="wall-pane-code">{hash.slice(0, 7)}</span>
          {stale && (
            <span className="wall-stale-mark" title="read before the last disconnect -- not current">
              STALE
            </span>
          )}
          <span className="flex-1" />
          <button type="button" className="wall-detail-close" title="Close (Esc)" onClick={closeWallDetail}>
            <X className="size-3.5" />
          </button>
        </header>
        <div className="wall-detail-body">
          <WallDetailBody detail={detail} hash={hash} />
        </div>
      </section>
    </div>
  )
}

/**
 * A read that did not land leaves `loading` standing rather than falling through
 * to `missing`: "the broker is gone" and "there is no such commit" are different
 * answers and only one of them is true. The STALE mark in the header is what
 * says which, once anything has landed at all.
 */
function WallDetailBody({ detail, hash }: { detail: CommitDetail; hash: string }) {
  if (detail.status === 'loading') return <p className="text-meta text-fg-faint">reading {hash.slice(0, 7)}</p>
  if (detail.status === 'missing') return <p className="text-meta text-fg-faint">no commit matches {hash}</p>
  return <CommitDetailView commit={detail.commit} />
}
