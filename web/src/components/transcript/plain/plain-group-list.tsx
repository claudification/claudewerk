/**
 * The plain renderer's group list: DisplayGroups mapped straight into document
 * flow -- no virtualizer, no absolute positioning, no measurement machinery.
 * Offscreen cost is handled by the browser via `content-visibility: auto` +
 * `contain-intrinsic-size` (.transcript-plain-group in globals.css; Safari
 * 18.1+, older engines degrade to render-everything -- slower but correct).
 */

import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { AnimatedGroupContent, type GroupContentProps, stableGroupKey } from '../group-content'
import type { DisplayGroup } from '../grouping'

/** Plain Renderer Lab knobs that shape the content-visibility box. Same for
 *  every group, so computed once. `undefined` = the .transcript-plain-group CSS
 *  class owns it (the production default path -- no inline override). */
function boxStyle(contentVisibility: boolean, intrinsicSize: number): CSSProperties | undefined {
  if (!contentVisibility) return { contentVisibility: 'visible' }
  if (intrinsicSize !== 200) return { containIntrinsicSize: `auto ${intrinsicSize}px` }
  return undefined
}

export function PlainGroupList({
  groups,
  enteringKey,
  settlingKey,
  clearEntering,
  clearSettling,
  contentVisibility,
  intrinsicSize,
  ...content
}: Omit<GroupContentProps, 'group'> & {
  groups: DisplayGroup[]
  enteringKey: string | null
  settlingKey: string | null
  clearEntering: () => void
  clearSettling: () => void
  /** Plain Renderer Lab: content-visibility on/off + its intrinsic-size seed. */
  contentVisibility: boolean
  intrinsicSize: number
}) {
  const style = boxStyle(contentVisibility, intrinsicSize)
  return (
    <>
      {groups.map(group => {
        const key = stableGroupKey(group)
        return (
          <AnimatedGroupContent
            key={key}
            // The continuation tuck lives on THIS wrapper (the content-visibility
            // box), not on GroupView's inner box -- a child pulled above the box
            // top would be clipped by contain:paint (the "cut text" bug). Moving
            // the whole box up avoids the clip. continuationOffset={false} stops
            // GroupView from also applying it inside.
            className={cn('transcript-plain-group', group.continuation && '-mt-2')}
            style={style}
            group={group}
            continuationOffset={false}
            isEntering={enteringKey === key}
            isSettling={settlingKey === key}
            clearEntering={clearEntering}
            clearSettling={clearSettling}
            {...content}
          />
        )
      })}
    </>
  )
}
