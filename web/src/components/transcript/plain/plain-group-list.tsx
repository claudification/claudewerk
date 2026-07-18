/**
 * The plain renderer's group list: DisplayGroups mapped straight into document
 * flow -- no virtualizer, no absolute positioning, no measurement machinery.
 * Offscreen cost is handled by the browser via `content-visibility: auto` +
 * `contain-intrinsic-size` (.transcript-plain-group in globals.css; Safari
 * 18.1+, older engines degrade to render-everything -- slower but correct).
 */

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
            className="transcript-plain-group"
            group={group}
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
