/**
 * TranscriptViewPlain -- non-virtualized transcript renderer. DEFAULT engine.
 * Selected when controlPanelPrefs.transcriptRenderer === 'plain' (Settings >
 * Experiments), the opt-out sibling of the legacy TanStack `TranscriptView`.
 * Plan + prior-art rationale: .claude/docs/plan-transcript-non-virtualized.md.
 *
 * Groups render in normal document flow and browser-native mechanisms do the
 * rest; all the wiring lives in use-plain-transcript.ts. The in-flight UI and
 * banners live INSIDE the observed content wrapper, so their growth is part of
 * the engine's resize pin -- no inside/outside placement problem.
 */

import { memo } from 'react'
import { MaybeProfiler } from '../../perf-profiler'
import { TranscriptEmptyState } from '../ghost-peek'
import { BannersBlock, InFlightBlock } from '../transcript-bottom'
import type { TranscriptViewProps } from '../transcript-view'
import { PlainGroupList } from './plain-group-list'
import { TopSentinel } from './top-sentinel'
import { usePlainTranscript } from './use-plain-transcript'

export const TranscriptViewPlain = memo(function TranscriptViewPlain(props: TranscriptViewProps) {
  const { conversationId, showThinking = false, cacheKey } = props
  const {
    engine,
    anchor,
    box,
    animations,
    getResult,
    settings,
    planContext,
    mainGroups,
    queuedGroups,
    regroupSignal,
    handleNearTop,
    isEmpty,
    hasMore,
  } = usePlainTranscript(props)

  return (
    <div
      ref={engine.scrollRef}
      data-perf-region="transcript"
      className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4"
      // overflow-anchor is the native path: 'auto' hands position-holding to
      // the browser (and the JS anchors stand down), 'none' keeps it in JS for
      // engines without scroll anchoring. anchor-strategy.ts decides.
      style={{ overscrollBehavior: 'contain', touchAction: 'pan-y', overflowAnchor: anchor.overflowAnchor }}
    >
      {isEmpty && <TranscriptEmptyState conversationId={cacheKey} />}
      <div ref={engine.contentRef}>
        {hasMore && <TopSentinel scrollRef={engine.scrollRef} reobserveKey={regroupSignal} onNearTop={handleNearTop} />}
        <MaybeProfiler id="TranscriptGroupsPlain">
          <PlainGroupList
            groups={mainGroups}
            box={box}
            conversationId={conversationId}
            getResult={getResult}
            settings={settings}
            showThinking={showThinking}
            planContext={planContext}
            enteringKey={animations.enteringKey}
            settlingKey={animations.settlingKey}
            clearEntering={animations.clearEntering}
            clearSettling={animations.clearSettling}
          />
        </MaybeProfiler>
        <InFlightBlock conversationId={conversationId} />
        <BannersBlock
          conversationId={conversationId}
          queuedGroups={queuedGroups}
          getResult={getResult}
          settings={settings}
          showThinking={showThinking}
        />
      </div>
    </div>
  )
})
