/**
 * TranscriptViewPlain -- non-virtualized transcript renderer.
 * Flag: controlPanelPrefs.plainTranscript (Settings > Experiments), A/B
 * sibling of the TanStack `TranscriptView`. Plan + prior-art rationale:
 * .claude/docs/plan-transcript-non-virtualized.md.
 *
 * Groups render in normal document flow; browser-native mechanisms do the
 * rest. ONE scroll writer -- nothing else may write scrollTop:
 * follow = use-plain-follow.ts (engine, instant pins); prepend =
 * use-prepend-anchor.ts (scrollHeight-delta, Safari-safe); backfill =
 * top-sentinel.tsx (IntersectionObserver, no scroll-gesture requirement);
 * offscreen = content-visibility CSS (plain-group-list.tsx). The in-flight UI
 * and banners live INSIDE the observed content wrapper, so their growth is
 * part of the engine's resize pin -- no inside/outside placement problem.
 */

import { memo, useCallback } from 'react'
import { MaybeProfiler } from '../../perf-profiler'
import { TranscriptEmptyState } from '../ghost-peek'
import { stableGroupKey } from '../group-content'
import { useIncrementalGroups } from '../grouping'
import { BannersBlock, InFlightBlock } from '../transcript-bottom'
import type { TranscriptViewProps } from '../transcript-view'
import { useTailAnimations } from '../use-tail-animations'
import { useLiveGroups, usePlanContext, useTranscriptSettings } from '../use-transcript-derivations'
import { useTranscriptWindow } from '../use-transcript-window'
import { PlainGroupList } from './plain-group-list'
import { TopSentinel } from './top-sentinel'
import { usePlainFollow } from './use-plain-follow'
import { usePrependAnchor } from './use-prepend-anchor'

// Cognitive cost is the hook orchestration itself (window + engine + anchor +
// grouping), already one-line-per-concern; further splitting hides the wiring.
// fallow-ignore-next-line complexity
export const TranscriptViewPlain = memo(function TranscriptViewPlain({
  conversationId,
  entries,
  follow = false,
  showThinking = false,
  onUserScroll,
  onReachedBottom,
  cacheKey,
}: TranscriptViewProps) {
  // Tail-append signal: the last entry's seq (uuid/length fallback for seqless
  // transcripts). Increments on a new tail message so the follow engine can
  // re-pin past a sub-threshold escape (see usePlainFollow quirk 1).
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null
  const tailSignal = lastEntry ? (lastEntry.seq ?? entries.length) : 0

  const engine = usePlainFollow({ cacheKey, follow, tailSignal, onUserScroll, onReachedBottom })
  const armPrependAnchor = usePrependAnchor(engine)

  // Shared progressive-window + scrollback data logic. No backfill group
  // breaks needed here: the scrollHeight-delta anchor measures the whole
  // container, so intra-group head growth is compensated exactly.
  const {
    windowed,
    windowStartRef,
    windowAnchorSeq,
    regroupSignal,
    hasMoreOlder,
    hasMoreOlderRef,
    loadEarlier,
    fetchOlder,
    loadingEarlierRef,
    fetchingOlderRef,
  } = useTranscriptWindow({ entries, cacheKey, follow, onBeforePrepend: armPrependAnchor })

  const { getResult, groups } = useIncrementalGroups(windowed, cacheKey, regroupSignal)
  const transcriptSettings = useTranscriptSettings()
  const planContext = usePlanContext(entries)
  const { mainGroups, queuedGroups, liveActive } = useLiveGroups(groups, conversationId)

  const tailGroup = mainGroups.length > 0 ? mainGroups[mainGroups.length - 1] : null
  const { enteringKey, settlingKey, clearEntering, clearSettling } = useTailAnimations({
    conversationId,
    cacheKey,
    tailKey: tailGroup ? stableGroupKey(tailGroup) : null,
    tailType: tailGroup?.type ?? null,
    windowAnchorSeq,
    liveActive,
  })

  // Backfill trigger: reveal loaded-but-windowed entries first, then fetch
  // older history from the broker. Re-entrancy guarded; the sentinel re-arms
  // itself via regroupSignal after each prepend.
  const handleNearTop = useCallback(() => {
    if (windowStartRef.current > 0) {
      if (loadingEarlierRef.current) return
      loadingEarlierRef.current = true
      console.debug('[window] sentinel -> loadEarlier (plain)')
      loadEarlier()
      requestAnimationFrame(() => {
        loadingEarlierRef.current = false
      })
    } else if (hasMoreOlderRef.current && !fetchingOlderRef.current) {
      console.debug('[window] sentinel -> fetchOlder (plain)')
      fetchOlder()
    }
  }, [windowStartRef, loadingEarlierRef, hasMoreOlderRef, fetchingOlderRef, loadEarlier, fetchOlder])

  const isEmpty = mainGroups.length === 0 && queuedGroups.length === 0
  const hasMore = hasMoreOlder || windowed.length < entries.length

  return (
    <div
      ref={engine.scrollRef}
      data-perf-region="transcript"
      className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4"
      // overflow-anchor:none -- Chrome/Firefox native scroll anchoring would
      // double-compensate against our prepend anchor (Safari has neither).
      style={{ overscrollBehavior: 'contain', touchAction: 'pan-y', overflowAnchor: 'none' }}
    >
      {isEmpty && <TranscriptEmptyState conversationId={cacheKey} />}
      <div ref={engine.contentRef}>
        {hasMore && <TopSentinel scrollRef={engine.scrollRef} reobserveKey={regroupSignal} onNearTop={handleNearTop} />}
        <MaybeProfiler id="TranscriptGroupsPlain">
          <PlainGroupList
            groups={mainGroups}
            conversationId={conversationId}
            getResult={getResult}
            settings={transcriptSettings}
            showThinking={showThinking}
            planContext={planContext}
            enteringKey={enteringKey}
            settlingKey={settlingKey}
            clearEntering={clearEntering}
            clearSettling={clearSettling}
          />
        </MaybeProfiler>
        <InFlightBlock conversationId={conversationId} />
        <BannersBlock
          conversationId={conversationId}
          queuedGroups={queuedGroups}
          getResult={getResult}
          settings={transcriptSettings}
          showThinking={showThinking}
        />
      </div>
    </div>
  )
})
