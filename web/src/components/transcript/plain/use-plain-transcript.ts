/**
 * All of TranscriptViewPlain's wiring, so the component itself stays markup.
 *
 * ONE scroll writer -- nothing else may write scrollTop:
 *   follow    = use-plain-follow.ts (engine, instant pins)
 *   anchoring = anchor-strategy.ts picks ONE of: the browser's native scroll
 *               anchoring, or our prepend + above-viewport anchors. Never both.
 *   backfill  = top-sentinel.tsx (IntersectionObserver, no scroll gesture)
 *   offscreen = content-visibility CSS, sized per group by use-group-heights.ts
 *   jump      = use-plain-jump-scroll.ts -- the ONLY user-requested scroll
 *               (a transcript-search hit). Runs once per jump, after follow is
 *               off, so it never races the follow engine for the bottom.
 */

import { useCallback, useEffect } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { plainLabSummary, resolvePlainRendererLab } from '@/lib/plain-renderer-lab'
import { stableGroupKey } from '../group-content'
import { useIncrementalGroups } from '../grouping'
import type { TranscriptViewProps } from '../transcript-view'
import { useTailAnimations } from '../use-tail-animations'
import { useLiveGroups, usePlanContext, useTranscriptSettings } from '../use-transcript-derivations'
import { useTranscriptJump } from '../use-transcript-jump'
import { useTranscriptWindow } from '../use-transcript-window'
import { resolveAnchorStrategy } from './anchor-strategy'
import type { BoxSizing } from './plain-group-list'
import { useAboveViewportAnchor } from './use-above-anchor'
import { useGroupHeights } from './use-group-heights'
import { usePlainFollow } from './use-plain-follow'
import { usePlainJumpScroll } from './use-plain-jump-scroll'
import { usePrependAnchor } from './use-prepend-anchor'

/** Names the configuration under test in device logs -- which anchoring
 *  actually resolved on THIS engine, plus any non-default lab knob. */
function useLabLog(resolved: string, summary: string | null): void {
  useEffect(() => {
    console.debug(`[plain-lab] anchoring=${resolved}${summary ? ` ${summary}` : ' (defaults)'}`)
  }, [resolved, summary])
}

/** Tail-append signal: the last entry's seq (uuid/length fallback for seqless
 *  transcripts). Increments on a new tail message so the follow engine can
 *  re-pin past a sub-threshold escape (see usePlainFollow quirk 1). */
function tailSignalOf(entries: TranscriptViewProps['entries']): number {
  const last = entries.length > 0 ? entries[entries.length - 1] : null
  return last ? (last.seq ?? entries.length) : 0
}

// The cognitive cost IS the wiring -- window + follow engine + anchoring +
// sizing + grouping, one line per concern. Splitting further hides it.
// fallow-ignore-next-line complexity
export function usePlainTranscript({
  conversationId,
  entries,
  follow = false,
  onUserScroll,
  onReachedBottom,
  cacheKey,
}: TranscriptViewProps) {
  // Plain Renderer Lab: per-device scroll-back knobs (lib/plain-renderer-lab.ts).
  const lab = resolvePlainRendererLab(useConversationsStore(s => s.controlPanelPrefs.plainRendererLab))
  // Native scroll anchoring where the engine has it, our JS anchors where it
  // does not -- never both (they double-compensate). See anchor-strategy.ts.
  const anchor = resolveAnchorStrategy(lab.anchorMode)
  useLabLog(anchor.resolved, plainLabSummary(lab))

  const engine = usePlainFollow({
    cacheKey,
    follow,
    tailSignal: tailSignalOf(entries),
    onUserScroll,
    onReachedBottom,
  })
  const armPrependAnchor = usePrependAnchor(engine, anchor.prependAnchor)
  // Scroll-anchoring polyfill for engines without native anchoring: compensates
  // content-visibility reserved->real inflation ABOVE a detached reader.
  useAboveViewportAnchor(engine, anchor.aboveAnchor)
  // Real heights back into the shared size cache, so each box reserves what it
  // actually needs. Only the offscreen-skipping path consumes them, so with
  // content-visibility off (the default) the recorder stands down rather than
  // running a ResizeObserver over every group for nobody -- and RO callbacks
  // during a scroll are precisely what we are trying not to do on WebKit.
  const sizes = useGroupHeights(engine.contentRef, cacheKey, lab.sizing === 'measured' && lab.contentVisibility)

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
    revealSeq,
    fetchOlder,
    loadingEarlierRef,
    fetchingOlderRef,
  } = useTranscriptWindow({ entries, cacheKey, follow, onBeforePrepend: armPrependAnchor })

  const { getResult, groups } = useIncrementalGroups(windowed, cacheKey, regroupSignal)
  const settings = useTranscriptSettings()
  const planContext = usePlanContext(entries)
  const { mainGroups, queuedGroups, liveActive } = useLiveGroups(groups, conversationId)

  // Transcript-search jump: fetch/reveal until the target seq is rendered, then
  // scroll to its group. Leaves follow on the way in, or the engine would pin
  // straight back to the bottom.
  const jump = useTranscriptJump({
    cacheKey,
    entries,
    groups: mainGroups,
    hasMoreOlder,
    fetchOlder,
    revealSeq,
    onLeaveFollow: onUserScroll,
  })
  usePlainJumpScroll(engine.contentRef, jump.groupKey, jump.onLanded)

  const tailGroup = mainGroups.length > 0 ? mainGroups[mainGroups.length - 1] : null
  const animations = useTailAnimations({
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

  const box: BoxSizing = {
    contentVisibility: lab.contentVisibility,
    sizing: lab.sizing,
    intrinsicSize: lab.intrinsicSize,
    sizes,
  }

  return {
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
    jumpHighlightKey: jump.highlightKey,
    isEmpty: mainGroups.length === 0 && queuedGroups.length === 0,
    hasMore: hasMoreOlder || windowed.length < entries.length,
  }
}
