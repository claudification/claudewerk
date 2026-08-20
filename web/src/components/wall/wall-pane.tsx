/**
 * WallPane -- the chrome EVERY pane in this epic wears.
 *
 * Header: title, reference code, then the three slots the mockup gives a pane
 * (count / tabs / copy) in that order. Body: the only thing that scrolls.
 *
 * A pane never sets its own border, padding or scrollbar. If a pane card needs a
 * different frame, the frame is wrong, not the pane.
 */

import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface WallPaneProps {
  title: string
  /** Reference code (P1, A7, ...) -- how a human and an agent point at a pane. */
  code: string
  /** Right-aligned caption: a row count, a window label. */
  count?: ReactNode
  /** Segmented control (BANDS/TIDE, 6h/24h/7d). */
  tabs?: ReactNode
  /** The universal copy affordance, supplied by the copy card. */
  copy?: ReactNode
  /** Take the leftover column height instead of sizing to content. */
  grow?: boolean
  /** Cap as a share of the column (the mockup's per-pane max-height). */
  maxHeight?: string
  /** Drop out of ambient mode entirely. */
  hideInAmbient?: boolean
  /**
   * THE STALENESS CONTRACT. Everything below this pane's header was read on an
   * EARLIER connection than the one the panel is on now.
   *
   * It lives on the shared chrome rather than in each pane for the same reason
   * the border does: a wall that marks staleness in nine places and forgets it in
   * the tenth is worse than one that never marked it, because now the absence of
   * a mark reads as a promise. Ambient mode is why it is a word and not a dot --
   * no chrome, no cursor, read from three metres away.
   */
  stale?: boolean
  children: ReactNode
}

export function WallPane({
  title,
  code,
  count,
  tabs,
  copy,
  grow,
  maxHeight,
  hideInAmbient,
  stale,
  children,
}: WallPaneProps) {
  const style: CSSProperties | undefined = maxHeight ? { maxHeight } : undefined
  return (
    <section
      className={cn('wall-pane', grow && 'wall-pane-grow', hideInAmbient && 'wall-hide-ambient')}
      style={style}
      data-pane={code}
      data-stale={stale ? 'true' : undefined}
      aria-label={title}
    >
      <div className="wall-pane-head">
        <h2 className="wall-pane-title">{title}</h2>
        <span className="wall-pane-code">{code}</span>
        {stale && (
          <span className="wall-stale-mark" title="read before the last disconnect -- not current">
            STALE
          </span>
        )}
        <span className="flex-1" />
        {count != null && <span className="wall-pane-count">{count}</span>}
        {tabs}
        {copy}
      </div>
      <div className="wall-pane-body">{children}</div>
    </section>
  )
}
