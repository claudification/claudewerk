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
import { useWallCursor } from '@/lib/wall/use-wall-cursor'

/**
 * WHAT THIS PANE CAN HONESTLY SHOW AT A PAST OFFSET.
 *
 * `rows`   -- its rows carry their own clock, so `useWallFilter` has already
 *             narrowed them to the ones that existed at the cursor. Exactly the
 *             panes that declare the `time` axis.
 * `series` -- no rows to drop, but a real history to look a value up in. The
 *             pane answers the cursor itself, per row (S1's ring, S2's chart).
 *
 * ABSENT IS THE DEFAULT AND IT MEANS BLIND: this pane has no history, so at a
 * past offset it has nothing true to say and its body is replaced by a line that
 * says exactly that. Defaulting the other way would make every pane added after
 * this card silently print live numbers under a `T-42m` header -- a lie by
 * omission, which is the one failure mode a rewind must not have.
 */
type WallRewind = 'rows' | 'series'

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
  /** What this pane can honestly show at a past offset. Absent = nothing. */
  rewind?: WallRewind
  children: ReactNode
}

/**
 * WHAT THE HEAD PRINTS WHERE THE COUNT GOES, when this pane cannot be rewound.
 * `null` means it can -- either it is LIVE, or it declared how.
 *
 * A hook rather than a branch inside `WallPane`, so the chrome reads as "here is
 * the state, here is the markup" instead of deriving one from the other halfway
 * down a JSX tree that already has four optional slots in it.
 */
function useBlindLabel(rewind: WallRewind | undefined): string | null {
  const { rewound, label } = useWallCursor()
  if (rewind !== undefined) return null
  return rewound ? label : null
}

/** The head, split out because it is where every optional slot lives -- five of
 *  them, each with its own condition, which is enough branching to be worth
 *  reading on its own rather than inside the section's attributes. */
function WallPaneHead({
  title,
  code,
  count,
  tabs,
  copy,
  stale,
  blindLabel,
}: Pick<WallPaneProps, 'title' | 'code' | 'count' | 'tabs' | 'copy' | 'stale'> & { blindLabel: string | null }) {
  return (
    <div className="wall-pane-head">
      <h2 className="wall-pane-title">{title}</h2>
      <span className="wall-pane-code">{code}</span>
      {stale && (
        <span className="wall-stale-mark" title="read before the last disconnect -- not current">
          STALE
        </span>
      )}
      <span className="flex-1" />
      {/* The count is the pane's claim about what it is showing. Blind, it is
          showing nothing, so printing a live `12/12` beside "no history at this
          offset" would have the pane contradict itself on screen -- the offset
          takes the slot instead. */}
      {blindLabel === null ? (
        count != null && <span className="wall-pane-count">{count}</span>
      ) : (
        <span className="wall-pane-count wall-blind-mark">{blindLabel}</span>
      )}
      {tabs}
      {copy}
    </div>
  )
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
  rewind,
  children,
}: WallPaneProps) {
  const style: CSSProperties | undefined = maxHeight ? { maxHeight } : undefined
  const blindLabel = useBlindLabel(rewind)
  return (
    <section
      className={cn('wall-pane', grow && 'wall-pane-grow', hideInAmbient && 'wall-hide-ambient')}
      style={style}
      data-pane={code}
      data-stale={stale ? 'true' : undefined}
      data-blind={blindLabel ? 'true' : undefined}
      aria-label={title}
    >
      <WallPaneHead
        title={title}
        code={code}
        count={count}
        tabs={tabs}
        copy={copy}
        stale={stale}
        blindLabel={blindLabel}
      />
      <div className="wall-pane-body">{blindLabel ? <WallPaneBlind /> : children}</div>
    </section>
  )
}

/** There is nothing behind this veil to squint at, so the body is REPLACED
 *  rather than dimmed. The words matter: "no history at this offset" is a
 *  statement about this pane, not about the fleet being quiet. */
function WallPaneBlind() {
  return <p className="wall-blind-line">no history at this offset</p>
}
