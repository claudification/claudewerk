/**
 * TranscriptViewVirtuoso - SPIKE (A/B) transcript renderer built on react-virtuoso.
 *
 * Parallel sibling to TranscriptView (TanStack). Flag-gated behind
 * controlPanelPrefs.virtuosoTranscript (default OFF). The whole point of the
 * spike is to let Virtuoso own the things we hand-built on TanStack and kept
 * fighting bugs on:
 *   - prepend anchoring        -> firstItemIndex (decrement on prepend)
 *   - smooth-follow on append  -> followOutput
 *   - at-bottom detection      -> atBottomStateChange
 *   - load-older on scroll-up  -> startReached (user-intent gated)
 *   - in-flight live tail      -> components.Footer
 *
 * REUSED AS-IS (virtualizer-agnostic): useIncrementalGroups grouping,
 * MemoizedGroupView / item-renderers, the settle morph + smooth-collapse CSS,
 * the in-flight decorations (in-flight-decorations.tsx, shared with the TanStack
 * path), ThinkingPill, Collapse. See plan-virtuoso-spike.md.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { fetchTranscriptBefore, useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  AskQuestionBanners,
  LinkRequestBanners,
  PermissionBanners,
  SpawnApprovalBanners,
} from '../conversation-detail/conversation-banners'
import { TranscriptEmptyState } from './ghost-peek'
import { CompactedDivider, CompactingBanner, MemoizedGroupView, SkillDivider } from './group-view'
import type { ResultLookup, TranscriptSettings } from './group-view-types'
import { type DisplayGroup, useIncrementalGroups } from './grouping'
import { StreamingTextBlock, StreamingThinkingBlock, ThinkingSpinner } from './in-flight-decorations'
import { ThinkingPill } from './thinking-pill'
import { usePlanContext, useTranscriptSettings } from './use-transcript-derivations'

/** Page size for the infinite-scrollback fetch (mirrors TranscriptView). */
const LOAD_CHUNK = 100
/** firstItemIndex seed -- large so prepends can decrement it for the life of the
 *  session without underflowing. Only the relative value matters to Virtuoso. */
const FIRST_INDEX_START = 1_000_000

/** Stable Virtuoso/React key for a group. Same convention as TranscriptView's
 *  stableGroupKey: prefer the reconciled `id` (carried across regroups so the
 *  group's DOM subtree -- Shiki/CodeMirror/Mermaid -- is reused, not remounted,
 *  on tail-append AND head-prepend). Falls back to the tail seq. */
function stableGroupKey(group: DisplayGroup): string {
  if (group.id) return group.id
  const tail = group.entries[group.entries.length - 1] as { seq?: number; uuid?: string } | undefined
  const id = tail?.seq ?? tail?.uuid ?? group.timestamp
  return `${group.type}-${id}`
}

/** Oldest seq currently held in `groups` (the head). Drops on a prepend, which
 *  is how we detect head-growth and decrement firstItemIndex. */
function oldestSeqOf(groups: DisplayGroup[]): number {
  const first = groups[0]?.entries[0] as { seq?: number } | undefined
  return first?.seq ?? 0
}

// ---------------------------------------------------------------------------
// Virtuoso Footer / EmptyPlaceholder (in-flight UI + queued tail).
// ---------------------------------------------------------------------------

interface FooterContext {
  conversationId: string | null
  queuedGroups: DisplayGroup[]
  getResult: ResultLookup
  settings: TranscriptSettings
  showThinking: boolean
  emptyKey?: string
}

/** In-flight turn + banners + queued groups, hosted below the last item as the
 *  Virtuoso Footer. Order is chronological: streaming thinking -> streaming text
 *  -> pill -> spinner -> banners -> queued. Each sub-block returns null when
 *  nothing is in-flight, so an idle transcript renders an empty footer. */
const InFlightFooter = memo(function InFlightFooter({ context }: { context: FooterContext }) {
  const { conversationId, queuedGroups, getResult, settings, showThinking } = context
  return (
    <div className="px-3 sm:px-4 pb-3 sm:pb-4">
      <StreamingThinkingBlock conversationId={conversationId} />
      <StreamingTextBlock conversationId={conversationId} />
      <ThinkingPill conversationId={conversationId} />
      <ThinkingSpinner conversationId={conversationId} />
      <div className="mt-2">
        <LinkRequestBanners />
        <PermissionBanners />
        <SpawnApprovalBanners />
        <AskQuestionBanners />
      </div>
      {queuedGroups.length > 0 && (
        <div className="mt-2 border-t border-dashed border-amber-500/30 pt-2">
          <div className="text-[10px] font-mono text-amber-500/60 px-1 mb-1">QUEUED</div>
          {queuedGroups.map((qg, i) => (
            <MemoizedGroupView
              // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key
              key={`queued-${qg.timestamp}-${i}`}
              group={qg}
              getResult={getResult}
              settings={settings}
              showThinking={showThinking}
            />
          ))}
        </div>
      )}
    </div>
  )
})

const EmptyPlaceholder = memo(function EmptyPlaceholder({ context }: { context: FooterContext }) {
  return <TranscriptEmptyState conversationId={context.emptyKey} />
})

// Stable components object -- a new identity here would remount Footer every
// render and kill the smooth-collapse on the in-flight decorations.
const VIRTUOSO_COMPONENTS = { Footer: InFlightFooter, EmptyPlaceholder } as const

interface TranscriptViewVirtuosoProps {
  entries: TranscriptEntry[]
  follow?: boolean
  showThinking?: boolean
  onUserScroll?: () => void
  onReachedBottom?: () => void
  cacheKey?: string
}

export const TranscriptViewVirtuoso = memo(function TranscriptViewVirtuoso({
  entries,
  follow = false,
  showThinking = false,
  onUserScroll,
  onReachedBottom,
  cacheKey,
}: TranscriptViewVirtuosoProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)

  // Grouping reset signal: identity of the oldest held entry. Changes on a
  // server prepend (head grows) so grouping does a full re-group; stays constant
  // during streaming (tail append) so streaming stays on the cheap incremental
  // path. Mirrors TranscriptView's regroupSignal (minus the window slice -- the
  // Virtuoso path feeds the full loaded transcript and lets Virtuoso virtualize).
  const regroupSignal = entries.length > 0 ? (entries[0].seq ?? entries[0].uuid ?? 0) : 0
  const { getResult, groups } = useIncrementalGroups(entries, cacheKey, regroupSignal)

  // Split: queued groups float in the Footer, the rest are virtualized rows.
  const { mainGroups, queuedGroups } = useMemo(() => {
    const main: DisplayGroup[] = []
    const queued: DisplayGroup[] = []
    for (const g of groups) {
      if (g.queued) queued.push(g)
      else main.push(g)
    }
    return { mainGroups: main, queuedGroups: queued }
  }, [groups])

  // Settings + plan content -- shared, virtualizer-agnostic derivations.
  const transcriptSettings = useTranscriptSettings()
  const planContext = usePlanContext(entries)

  // Live-turn state (drives the settle/enter detection + the smooth-follow gate).
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const convActive = useConversationsStore(state =>
    selectedConversationId ? state.conversationsById[selectedConversationId]?.status === 'active' : false,
  )
  const streamingPresent = useConversationsStore(state =>
    selectedConversationId
      ? !!(state.streamingText[selectedConversationId] || state.streamingThinking[selectedConversationId])
      : false,
  )
  const liveActive = convActive || streamingPresent

  const tailKey = mainGroups.length > 0 ? stableGroupKey(mainGroups[mainGroups.length - 1]) : null

  // ENTER ANIMATION -- slide up + fade in the newest group, ONLY for a genuine
  // new idle entry (never while a turn is live: the streaming IS the animation).
  const [enteringKey, setEnteringKey] = useState<string | null>(null)
  const prevTailKeyRef = useRef<string | null>(null)
  const enterCacheKeyRef = useRef(cacheKey)
  const pendingEnterRef = useRef<string | null>(null)
  const shouldEnter =
    tailKey !== null &&
    tailKey !== prevTailKeyRef.current &&
    prevTailKeyRef.current !== null &&
    cacheKey === enterCacheKeyRef.current &&
    !liveActive
  if (shouldEnter) pendingEnterRef.current = tailKey
  prevTailKeyRef.current = tailKey
  enterCacheKeyRef.current = cacheKey
  // biome-ignore lint/correctness/useExhaustiveDependencies: tailKey is the intentional trigger
  useEffect(() => {
    const key = pendingEnterRef.current
    if (key) {
      pendingEnterRef.current = null
      setEnteringKey(key)
    }
  }, [tailKey])
  const clearEntering = useCallback(() => setEnteringKey(null), [])

  // SETTLE MORPH -- when the streaming TEXT buffer clears, the committed
  // assistant group has taken over; tag it so its wrapper plays `assistant-settle`
  // (the emerald accent fades, opacity rises). Detected off the true->false edge.
  const [settlingKey, setSettlingKey] = useState<string | null>(null)
  const streamingTextPresent = useConversationsStore(state =>
    selectedConversationId ? !!state.streamingText[selectedConversationId] : false,
  )
  const prevStreamingTextRef = useRef(streamingTextPresent)
  const pendingSettleRef = useRef<string | null>(null)
  const settleTailGroup = mainGroups.length > 0 ? mainGroups[mainGroups.length - 1] : null
  if (
    prevStreamingTextRef.current &&
    !streamingTextPresent &&
    tailKey !== null &&
    settleTailGroup?.type === 'assistant'
  ) {
    pendingSettleRef.current = tailKey
  }
  prevStreamingTextRef.current = streamingTextPresent
  // biome-ignore lint/correctness/useExhaustiveDependencies: streamingTextPresent is the intentional trigger
  useEffect(() => {
    const key = pendingSettleRef.current
    if (key) {
      pendingSettleRef.current = null
      setSettlingKey(key)
    }
  }, [streamingTextPresent])
  const clearSettling = useCallback(() => setSettlingKey(null), [])

  // -------------------------------------------------------------------------
  // firstItemIndex prepend anchoring. When older entries are prepended (server
  // fetchOlder -> prependTranscript), groups grow at the HEAD. Virtuoso keeps
  // the reading position fixed iff firstItemIndex decrements by exactly the
  // number of prepended items. Detect head-growth via the oldest seq dropping;
  // the count delta is the head delta (a prepend never touches the tail).
  // -------------------------------------------------------------------------
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_INDEX_START)
  const prevCacheKeyRef = useRef(cacheKey)
  const prevOldestSeqRef = useRef(oldestSeqOf(mainGroups))
  const prevGroupCountRef = useRef(mainGroups.length)

  const isSwitch = cacheKey !== prevCacheKeyRef.current
  if (isSwitch) prevCacheKeyRef.current = cacheKey
  const oldestSeq = oldestSeqOf(mainGroups)
  if (
    !isSwitch &&
    oldestSeq > 0 &&
    prevOldestSeqRef.current > 0 &&
    oldestSeq < prevOldestSeqRef.current &&
    mainGroups.length > prevGroupCountRef.current
  ) {
    const headDelta = mainGroups.length - prevGroupCountRef.current
    setFirstItemIndex(f => f - headDelta)
  }
  prevOldestSeqRef.current = oldestSeq
  prevGroupCountRef.current = mainGroups.length

  // -------------------------------------------------------------------------
  // Follow / pin-to-bottom. Instant on switch + cold-open fill; smooth on live
  // append while at bottom. Virtuoso's followOutput owns the append-follow; the
  // switch/cold-open pin is imperative (followOutput doesn't fire on a data
  // wholesale-replace or empty->filled transition).
  // -------------------------------------------------------------------------
  const atBottomRef = useRef(true)
  const followSmoothRef = useRef(false)
  const pinnedForKeyRef = useRef<string | null | undefined>(undefined)
  const onUserScrollRef = useRef(onUserScroll)
  onUserScrollRef.current = onUserScroll
  const onReachedBottomRef = useRef(onReachedBottom)
  onReachedBottomRef.current = onReachedBottom

  // Reset the pin + smooth gate on every conversation switch. followSmoothRef
  // stays false through the initial measurement burst so the entry snaps
  // INSTANTLY to the bottom instead of smooth-crawling; flipped true a beat
  // after settle so subsequent growth follows smoothly. Mirrors TranscriptView.
  useEffect(() => {
    pinnedForKeyRef.current = null
    followSmoothRef.current = false
    const id = setTimeout(() => {
      followSmoothRef.current = true
    }, 350)
    return () => clearTimeout(id)
  }, [cacheKey])

  // Pin to bottom once the current conversation has content (handles both the
  // warm switch -- groups present immediately from the grouping cache -- and the
  // cold open -- groups arrive a beat after the fetch resolves). Runs after every
  // commit but no-ops once pinned for the active cacheKey.
  useEffect(() => {
    if (pinnedForKeyRef.current === cacheKey) return
    if (mainGroups.length === 0) return
    pinnedForKeyRef.current = cacheKey
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
    onReachedBottomRef.current?.()
  })

  // Re-pin when the parent toggles follow ON (ScrollToBottomButton click).
  useEffect(() => {
    if (follow && !atBottomRef.current) {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' })
    }
  }, [follow])

  // -------------------------------------------------------------------------
  // Infinite scrollback. startReached fires when the first item enters the
  // viewport; gate on genuine user scrolling so programmatic scrolls (switch
  // pin, follow re-pin, prepend anchor) can never trigger a backfill.
  // -------------------------------------------------------------------------
  const userScrollingRef = useRef(false)
  const userScrollResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchingOlderRef = useRef(false)
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const cacheKeyRef = useRef(cacheKey)
  cacheKeyRef.current = cacheKey

  const fetchOlder = useCallback(() => {
    const cid = cacheKeyRef.current
    const oldest = entriesRef.current[0]?.seq
    if (!cid || oldest === undefined || oldest <= 1 || fetchingOlderRef.current) return
    fetchingOlderRef.current = true
    fetchTranscriptBefore(cid, oldest, LOAD_CHUNK)
      .then(res => {
        if (res && res.entries.length > 0) {
          useConversationsStore.getState().prependTranscript(cid, res.entries)
        }
        fetchingOlderRef.current = false
      })
      .catch(() => {
        fetchingOlderRef.current = false
      })
  }, [])

  const handleStartReached = useCallback(() => {
    if (!userScrollingRef.current) return
    fetchOlder()
  }, [fetchOlder])

  // Mark genuine user scrolling (wheel/touch) for a short tail so momentum
  // scroll still counts. Attached to Virtuoso's scroller element.
  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    if (!el || el instanceof Window) return
    const onUserInput = () => {
      userScrollingRef.current = true
      if (userScrollResetRef.current) clearTimeout(userScrollResetRef.current)
      userScrollResetRef.current = setTimeout(() => {
        userScrollingRef.current = false
      }, 200)
    }
    el.addEventListener('wheel', onUserInput, { passive: true })
    el.addEventListener('touchstart', onUserInput, { passive: true })
    el.addEventListener('touchmove', onUserInput, { passive: true })
  }, [])

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom
    if (atBottom) {
      onReachedBottomRef.current?.()
    } else if (userScrollingRef.current) {
      // Only a genuine user scroll-away kills follow -- a programmatic scroll
      // (pin, prepend) must never flip it off.
      onUserScrollRef.current?.()
    }
  }, [])

  // -------------------------------------------------------------------------
  // Item renderer. Special-cases compacted/compacting/skill (rendered outside
  // GroupView in the TanStack path too), else MemoizedGroupView. The wrapper
  // carries the enter/settle animation classes.
  // -------------------------------------------------------------------------
  const itemContent = useCallback(
    (_index: number, group: DisplayGroup) => {
      const itemKey = stableGroupKey(group)
      const isEntering = enteringKey === itemKey
      const isSettling = settlingKey === itemKey
      return (
        <div className="px-3 sm:px-4">
          <div
            className={cn(isEntering && 'transcript-entry-enter', isSettling && 'assistant-settle')}
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
            {(() => {
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
                return <SkillDivider name={group.skillName || 'skill'} content={content} />
              }
              return (
                <MemoizedGroupView
                  group={group}
                  getResult={getResult}
                  settings={transcriptSettings}
                  showThinking={showThinking}
                  planContext={planContext}
                />
              )
            })()}
          </div>
        </div>
      )
    },
    [enteringKey, settlingKey, clearEntering, clearSettling, getResult, transcriptSettings, showThinking, planContext],
  )

  const computeItemKey = useCallback((_index: number, group: DisplayGroup) => stableGroupKey(group), [])

  const footerContext = useMemo<FooterContext>(
    () => ({
      conversationId: selectedConversationId,
      queuedGroups,
      getResult,
      settings: transcriptSettings,
      showThinking,
      emptyKey: cacheKey,
    }),
    [selectedConversationId, queuedGroups, getResult, transcriptSettings, showThinking, cacheKey],
  )

  const followOutput = useCallback((atBottom: boolean) => {
    if (!atBottom) return false
    return followSmoothRef.current ? ('smooth' as const) : ('auto' as const)
  }, [])

  return (
    <div className="flex-1 min-h-0" data-perf-region="transcript-virtuoso">
      <Virtuoso<DisplayGroup, FooterContext>
        ref={virtuosoRef}
        data={mainGroups}
        context={footerContext}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={Math.max(0, mainGroups.length - 1)}
        computeItemKey={computeItemKey}
        itemContent={itemContent}
        components={VIRTUOSO_COMPONENTS}
        followOutput={followOutput}
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={40}
        startReached={handleStartReached}
        scrollerRef={scrollerRef}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        className="h-full pt-3 sm:pt-4"
        style={{ overscrollBehavior: 'contain', touchAction: 'pan-y' }}
      />
    </div>
  )
})
