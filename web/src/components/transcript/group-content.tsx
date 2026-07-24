/**
 * Renders the content of one DisplayGroup -- the group-type dispatch shared by
 * both transcript renderers (TanStack `TranscriptView` and
 * `TranscriptViewPlain`). Extracted from TranscriptView's virtual-item map so
 * the plain renderer doesn't duplicate the switch.
 */

import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { CompactedDivider, CompactingBanner, MemoizedGroupView, SkillDivider } from './group-view'
import type { TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'
import { detectReportArtifactRelPath } from './grouping/report-artifact'

type ResultLookup = Parameters<typeof MemoizedGroupView>[0]['getResult']
type PlanContext = Parameters<typeof MemoizedGroupView>[0]['planContext']

/** Stable render key for a group. Prefers the group's reconciled `id`
 *  (assigned by useIncrementalGroups), which is carried across regroups so it
 *  is invariant under BOTH a tail-append (streaming grows the LAST group at
 *  its tail) AND a head-prune/prepend (backfill grows the boundary group at
 *  its head). Falls back to the tail seq for batch-built groups without an id. */
export function stableGroupKey(group: DisplayGroup): string {
  if (group.id) return group.id
  const tail = group.entries[group.entries.length - 1] as { seq?: number; uuid?: string } | undefined
  const id = tail?.seq ?? tail?.uuid ?? group.timestamp
  return `${group.type}-${id}`
}

export interface GroupContentProps {
  group: DisplayGroup
  conversationId: string
  getResult: ResultLookup
  settings: TranscriptSettings
  showThinking: boolean
  planContext: PlanContext
  /** False when an outer wrapper owns the continuation tuck (plain renderer);
   *  see GroupView's continuationOffset. Defaults true (virtualized). */
  continuationOffset?: boolean
}

/** GroupContent wrapped in the enter/settle animation div (classes +
 *  animationend clearing) -- the same wrapper both renderers need around every
 *  committed group. */
export function AnimatedGroupContent({
  isEntering,
  isSettling,
  clearEntering,
  clearSettling,
  className,
  style,
  ...content
}: GroupContentProps & {
  isEntering: boolean
  isSettling: boolean
  clearEntering: () => void
  clearSettling: () => void
  className?: string
  /** Inline overrides for the content-visibility box (Plain Renderer Lab
   *  drives content-visibility / contain-intrinsic-size through here). */
  style?: CSSProperties
}) {
  return (
    <div
      style={style}
      className={cn(className, isEntering && 'transcript-entry-enter', isSettling && 'assistant-settle')}
      onAnimationEnd={
        isEntering || isSettling
          ? e => {
              if (e.animationName === 'transcript-entry-enter') clearEntering()
              else if (e.animationName === 'assistant-settle-bar' || e.animationName === 'assistant-settle-text')
                clearSettling()
            }
          : undefined
      }
    >
      <GroupContent {...content} />
    </div>
  )
}

// The per-type dispatch is a flat early-return switch; splitting it further
// would just scatter the group taxonomy across files.
// fallow-ignore-next-line complexity
function GroupContent({
  group,
  conversationId,
  getResult,
  settings,
  showThinking,
  planContext,
  continuationOffset,
}: GroupContentProps) {
  if (group.type === 'compacted') return <CompactedDivider />
  if (group.type === 'compacting') return <CompactingBanner />
  if (group.type === 'skill') {
    const entry = group.entries[0] as {
      message?: { content?: string | Array<{ type: string; text?: string }> }
    }
    let content = ''
    if (Array.isArray(entry?.message?.content)) {
      const parts: string[] = []
      for (const b of entry.message.content) {
        if (b.type === 'text') parts.push(b.text || '')
      }
      content = parts.join('')
    }
    const reportRel = detectReportArtifactRelPath(content)
    const reportArtifact = reportRel && conversationId ? { conversationId, relPath: reportRel } : undefined
    return <SkillDivider name={group.skillName || 'skill'} content={content} reportArtifact={reportArtifact} />
  }
  return (
    <MemoizedGroupView
      group={group}
      getResult={getResult}
      settings={settings}
      showThinking={showThinking}
      planContext={planContext}
      continuationOffset={continuationOffset}
    />
  )
}
