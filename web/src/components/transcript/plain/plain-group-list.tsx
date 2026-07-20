/**
 * The plain renderer's group list: DisplayGroups mapped straight into document
 * flow -- no virtualizer, no absolute positioning, no measurement machinery.
 * Offscreen cost is handled by the browser via `content-visibility: auto` +
 * `contain-intrinsic-size` (.transcript-plain-group in globals.css; Safari
 * 18.1+, older engines degrade to render-everything -- slower but correct).
 */

import { cn } from '@/lib/utils'
import { AnimatedGroupContent, type GroupContentProps, stableGroupKey } from '../group-content'
import type { DisplayGroup } from '../grouping'

export function PlainGroupList({
  groups,
  enteringKey,
  settlingKey,
  clearEntering,
  clearSettling,
  ...content
}: Omit<GroupContentProps, 'group'> & {
  groups: DisplayGroup[]
  enteringKey: string | null
  settlingKey: string | null
  clearEntering: () => void
  clearSettling: () => void
}) {
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
