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
  children: ReactNode
}

export function WallPane({ title, code, count, tabs, copy, grow, maxHeight, hideInAmbient, children }: WallPaneProps) {
  const style: CSSProperties | undefined = maxHeight ? { maxHeight } : undefined
  return (
    <section
      className={cn('wall-pane', grow && 'wall-pane-grow', hideInAmbient && 'wall-hide-ambient')}
      style={style}
      data-pane={code}
      aria-label={title}
    >
      <div className="wall-pane-head">
        <h2 className="wall-pane-title">{title}</h2>
        <span className="wall-pane-code">{code}</span>
        <span className="flex-1" />
        {count != null && <span className="wall-pane-count">{count}</span>}
        {tabs}
        {copy}
      </div>
      <div className="wall-pane-body">{children}</div>
    </section>
  )
}
