/**
 * The plain renderer's group list: DisplayGroups mapped straight into document
 * flow -- no virtualizer, no absolute positioning, no measurement machinery.
 * Offscreen cost is handled by the browser via `content-visibility: auto` +
 * `contain-intrinsic-size` (.transcript-plain-group in globals.css; Safari
 * 18.1+, older engines degrade to render-everything -- slower but correct).
 *
 * Each box's reserved height comes from the shared size cache / content-derived
 * estimate (group-sizing.ts) rather than one flat number for every group -- see
 * use-group-heights.ts for why that is the scroll-back fix and not a nicety.
 */

import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { AnimatedGroupContent, type GroupContentProps, stableGroupKey } from '../group-content'
import { estimateGroupSize } from '../group-sizing'
import type { DisplayGroup } from '../grouping'
import type { GroupSizing } from './anchor-strategy'
import { intrinsicStyle } from './use-group-heights'

/** Plain Renderer Lab knobs that shape the content-visibility box. */
export interface BoxSizing {
  /** content-visibility on each group (offscreen layout skipping). */
  contentVisibility: boolean
  /** 'measured' = per-group height from the shared cache/estimator (default).
   *  'flat' = one `intrinsicSize` for every group (the legacy guess). */
  sizing: GroupSizing
  /** The flat seed, used only when `sizing` is 'flat'. */
  intrinsicSize: number
  /** Per-conversation measured heights, filled by useGroupHeights. */
  sizes: Map<string, number>
}

/** Style for ONE group's box. `undefined` -- the default -- means plain
 *  document flow: no content-visibility, so the group lays out at its real
 *  height immediately and can never shove the reader by inflating later. Only
 *  the opt-in offscreen-skipping path needs an inline style. */
function boxStyle(group: DisplayGroup, key: string, box: BoxSizing): CSSProperties | undefined {
  if (!box.contentVisibility) return undefined
  const reserved =
    box.sizing === 'flat'
      ? intrinsicStyle(box.intrinsicSize, 1)
      : intrinsicStyle(estimateGroupSize(group, box.sizes, key))
  return skippingStyle(reserved)
}

/** `content-visibility: auto` paired with a reserved height, memoized on the
 *  reserved-height object so identity stays stable per bucket. */
const skippingStyles = new WeakMap<CSSProperties, CSSProperties>()
function skippingStyle(reserved: CSSProperties): CSSProperties {
  const existing = skippingStyles.get(reserved)
  if (existing) return existing
  const style: CSSProperties = { contentVisibility: 'auto', ...reserved }
  skippingStyles.set(reserved, style)
  return style
}

export function PlainGroupList({
  groups,
  enteringKey,
  settlingKey,
  clearEntering,
  clearSettling,
  box,
  ...content
}: Omit<GroupContentProps, 'group'> & {
  groups: DisplayGroup[]
  enteringKey: string | null
  settlingKey: string | null
  clearEntering: () => void
  clearSettling: () => void
  box: BoxSizing
}) {
  return (
    <>
      {groups.map(group => {
        const key = stableGroupKey(group)
        return (
          <AnimatedGroupContent
            key={key}
            groupKey={key}
            // The continuation tuck lives on THIS wrapper (the content-visibility
            // box), not on GroupView's inner box -- a child pulled above the box
            // top would be clipped by contain:paint (the "cut text" bug). Moving
            // the whole box up avoids the clip. continuationOffset={false} stops
            // GroupView from also applying it inside.
            className={cn('transcript-plain-group', group.continuation && '-mt-2')}
            style={boxStyle(group, key, box)}
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
