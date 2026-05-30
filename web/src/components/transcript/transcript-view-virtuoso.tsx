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

// ---------------------------------------------------------------------------
// In-flight block + EmptyPlaceholder.
// ---------------------------------------------------------------------------

interface EmptyContext {
  emptyKey?: string
}

/** In-flight turn + banners + queued groups. Rendered INSIDE the LAST list item
 *  (not as a Virtuoso Footer -- see the comment on the follow effect). Putting it
 *  inside the last item means its streaming growth counts toward that item's
 *  MEASURED height, which is what `totalListHeightChanged` reports and what the
 *  height-follow pins on -- the exact mechanism TranscriptView (TanStack) uses
 *  via its `isLast` block + totalSize effect. A Footer's height does not feed
 *  `totalListHeightChanged`, which is why streaming never followed before.
 *  Order is chronological: streaming thinking -> streaming text -> pill ->
 *  spinner -> banners -> queued. Each sub-block returns null when nothing is
 *  in-flight, so an idle last item renders only its committed content. */
const InFlightBlock = memo(function InFlightBlock({
  conversationId,
  queuedGroups,
  getResult,
  settings,
  showThinking,
}: {
  conversationId: string | null
  queuedGroups: DisplayGroup[]
  getResult: ResultLookup
  settings: TranscriptSettings
  showThinking: boolean
}) {
  return (
    <div className="pb-3 sm:pb-4">
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

const EmptyPlaceholder = memo(function EmptyPlaceholder({ context }: { context: EmptyContext }) {
  return <TranscriptEmptyState conversationId={context.emptyKey} />
})

// Stable components object -- a new identity here would remount on every render.
// No Footer: the in-flight block lives inside the last item now.
const VIRTUOSO_COMPONENTS = { EmptyPlaceholder } as const

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
  // firstItemIndex maintenance via a single TAIL anchor. Virtuoso's
  // firstItemIndex is the absolute index of data[0]; its contract requires the
  // delta to equal the change in HEAD item count -- decrement on prepend,
  // INCREMENT on head removal (see react-virtuoso dist/index.d.ts). The head
  // moves in TWO ways here, and the old oldest-seq+count-delta heuristic only
  // caught the first:
  //   - prepend: server fetchOlder -> prependTranscript grows the head (pure
  //              head-grow, no tail change).
  //   - prune:   TRANSCRIPT_LIVE_CAP eviction (handleTranscriptEntries) drops
  //              the head DURING a live tail-append -- a single store update
  //              both appends a tail group AND removes head groups. The count
  //              delta is then NOT the head delta, so the old code never
  //              incremented firstItemIndex and the viewport jumped backward.
  // The previous render's TAIL group survives BOTH (only the head ever moves),
  // so anchor on it: shift firstItemIndex by the negative of the anchor's index
  // movement. delta>0 (prepend) -> decrement; delta<0 (prune) -> increment;
  // delta==0 (pure tail append) -> no-op. Group `id` is reconciliation-stable
  // across append/prepend (commit 9dfcad57) so the anchor key holds, and this
  // is immune to the entry-vs-group unit mismatch (prune counts entries; `data`
  // here is groups).
  // -------------------------------------------------------------------------
  const [firstItemIndex, setFirstItemIndex] = useState(FIRST_INDEX_START)
  const prevCacheKeyRef = useRef(cacheKey)
  const anchorKeyRef = useRef<string | null>(null)
  const anchorIdxRef = useRef(-1)

  const isSwitch = cacheKey !== prevCacheKeyRef.current
  if (isSwitch) prevCacheKeyRef.current = cacheKey
  if (!isSwitch && anchorKeyRef.current !== null) {
    const newIdx = mainGroups.findIndex(g => stableGroupKey(g) === anchorKeyRef.current)
    if (newIdx >= 0 && newIdx !== anchorIdxRef.current) {
      setFirstItemIndex(f => f - (newIdx - anchorIdxRef.current))
    }
  }
  // Re-arm the anchor to the CURRENT tail for the next render's comparison.
  const anchorIdx = mainGroups.length - 1
  anchorKeyRef.current = anchorIdx >= 0 ? stableGroupKey(mainGroups[anchorIdx]) : null
  anchorIdxRef.current = anchorIdx

  // -------------------------------------------------------------------------
  // Follow / pin-to-bottom. Instant on switch + cold-open fill; smooth on live
  // append while at bottom. We DO NOT rely on Virtuoso's followOutput for the
  // append-follow: followOutput only fires when the total item COUNT changes
  // (dist/index.d.ts: "scrolls to bottom if the total count is changed"). While
  // tailing past TRANSCRIPT_LIVE_CAP every live append also prunes the head, so
  // the net group count is flat and followOutput never fires -- the view stops
  // auto-scrolling. So the append-follow is imperative too, driven by the tail
  // group's identity changing (count-independent). followOutput stays wired as a
  // cheap backstop for the sub-cap case but is not load-bearing.
  // -------------------------------------------------------------------------
  const atBottomRef = useRef(true)
  // FALSE during the initial post-switch measurement burst so entering a
  // conversation SNAPS instantly to the bottom; flipped true a beat after settle
  // so subsequent growth (streaming/pills) follows SMOOTHLY. Mirrors TranscriptView.
  const followSmoothRef = useRef(false)
  const pinnedForKeyRef = useRef<string | null | undefined>(undefined)
  // Last measured total list height, for the growth-only follow guard. Reset to
  // 0 on switch so the first measure of a fresh conversation counts as growth.
  const prevListHeightRef = useRef(0)
  // AUTHORITATIVE follow state, driven ENTIRELY by scroll POSITION (see the
  // scroll handler in scrollerRef), NOT by raw wheel/touch events. The earlier
  // version detached on any touchmove, which on a touch device killed follow the
  // moment you touched the screen -- so posting a message (you're touching) never
  // followed. Now: attach whenever the viewport is near the bottom, detach only
  // on a genuine UPWARD scroll well clear of the bottom. Content growing below
  // never moves scrollTop up, and our own pin scrolls DOWN, so neither can
  // spuriously detach. Mirrors TranscriptView's onScroll drift logic.
  const followingRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const scrollerElRef = useRef<HTMLElement | null>(null)
  const onUserScrollRef = useRef(onUserScroll)
  onUserScrollRef.current = onUserScroll
  const onReachedBottomRef = useRef(onReachedBottom)
  onReachedBottomRef.current = onReachedBottom

  // Pin to the TRUE bottom of the scroller (scrollHeight), NOT scrollToIndex
  // align:'end' -- the latter aligns the item's box and undershoots by the
  // scroller's bottom padding/footer (the "~20px I have to scroll every time").
  // scrollHeight reaches the real bottom including all of it. Falls back to the
  // imperative index scroll only if the scroller element isn't captured yet.
  const pinToBottom = useCallback((smooth: boolean) => {
    const el = scrollerElRef.current
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    } else {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: smooth ? 'smooth' : 'auto' })
    }
  }, [])

  // Reset the pin on every conversation switch (re-attach follow + recount the
  // first height measurement of the fresh conversation as growth).
  useEffect(() => {
    pinnedForKeyRef.current = null
    prevListHeightRef.current = 0
    followingRef.current = true
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
    pinToBottom(false)
    onReachedBottomRef.current?.()
  })

  // Re-pin when the parent toggles follow ON (ScrollToBottomButton click). This
  // is an explicit user "take me to the bottom", so re-attach the local follow.
  useEffect(() => {
    if (follow && !atBottomRef.current) {
      followingRef.current = true
      pinToBottom(true)
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

  // Scroller wiring. `markScrolling` flags genuine user input (wheel/touch) for a
  // short tail so the startReached load-gate and the detach below can tell user
  // scrolls from programmatic ones. The `scroll` handler is the SOLE owner of
  // follow attach/detach, driven by scroll POSITION (drift from the bottom):
  //   - drift < 40px              -> at the bottom -> ATTACH (re-follow).
  //   - moved UP + user + drift>120 -> a real scroll-away -> DETACH.
  // Content growth never moves scrollTop up (it grows below) and our pin scrolls
  // DOWN, so neither trips the detach -- only a deliberate scroll-up does. This
  // is why touching the screen / posting a message no longer kills follow.
  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    if (!el || el instanceof Window) return
    scrollerElRef.current = el
    const markScrolling = () => {
      userScrollingRef.current = true
      if (userScrollResetRef.current) clearTimeout(userScrollResetRef.current)
      userScrollResetRef.current = setTimeout(() => {
        userScrollingRef.current = false
      }, 200)
    }
    const onScroll = () => {
      const st = el.scrollTop
      const movedUp = st < lastScrollTopRef.current - 1
      lastScrollTopRef.current = st
      const drift = el.scrollHeight - st - el.clientHeight
      if (drift < 40) {
        if (!followingRef.current) {
          followingRef.current = true
          onReachedBottomRef.current?.()
        }
      } else if (movedUp && userScrollingRef.current && drift > 120) {
        if (followingRef.current) {
          followingRef.current = false
          onUserScrollRef.current?.()
        }
      }
    }
    el.addEventListener('wheel', markScrolling, { passive: true })
    el.addEventListener('touchstart', markScrolling, { passive: true })
    el.addEventListener('touchmove', markScrolling, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
  }, [])

  // atBottomStateChange only mirrors Virtuoso's at-bottom flag into a ref (used by
  // the follow-toggle effect). Follow attach/detach lives in the scroll handler.
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom
  }, [])

  // Height-growth follow. Mirrors TranscriptView's totalSize effect: Virtuoso's
  // `totalListHeightChanged` fires whenever the measured total item height
  // changes -- which now includes the in-flight block (it lives inside the LAST
  // item, see InFlightBlock), so this catches BOTH a new committed group AND
  // streaming text/pills/spinner growing the last item in place. followOutput is
  // count-based and so misses both the in-place growth and the prune-keeps-count
  // -flat case; this height signal does not. Pin on GROWTH only (a shrink -- the
  // in-flight decorations collapsing away -- settles on its own; an extra scroll
  // would fight the smooth collapse). Gated on being at the bottom / following so
  // a scrolled-up reader is never yanked, and on the initial pin having run.
  const handleTotalListHeightChanged = useCallback((height: number) => {
    const grew = height > prevListHeightRef.current
    prevListHeightRef.current = height
    if (!grew) return
    if (pinnedForKeyRef.current !== cacheKeyRef.current) return
    // Follow iff the scroll handler says we're attached. (No userScrolling guard:
    // on touch, every tap sets that flag and would block the follow we want.)
    if (!followingRef.current) return
    // SMOOTH once settled (the sweet follow), INSTANT during the post-switch burst
    // so a conversation switch snaps to the bottom instead of smooth-crawling.
    // Sticking is owned by the scroll-position follow above, not by the behavior.
    pinToBottom(followSmoothRef.current)
  }, [])

  // Latest in-flight inputs, read by itemContent for the LAST item without
  // widening its dependency list (queuedGroups churns every transcript change).
  const tailKeyRef = useRef(tailKey)
  tailKeyRef.current = tailKey
  const inflightRef = useRef({ conversationId: selectedConversationId, queuedGroups })
  inflightRef.current = { conversationId: selectedConversationId, queuedGroups }

  // -------------------------------------------------------------------------
  // Item renderer. Special-cases compacted/compacting/skill (rendered outside
  // GroupView in the TanStack path too), else MemoizedGroupView. The wrapper
  // carries the enter/settle animation classes. The LAST item also hosts the
  // in-flight block (streaming/banners/queued) so its growth feeds the
  // height-follow above -- the TranscriptView `isLast` pattern.
  // -------------------------------------------------------------------------
  const itemContent = useCallback(
    (_index: number, group: DisplayGroup) => {
      const itemKey = stableGroupKey(group)
      const isEntering = enteringKey === itemKey
      const isSettling = settlingKey === itemKey
      const isLast = itemKey === tailKeyRef.current
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
          {isLast && (
            <InFlightBlock
              conversationId={inflightRef.current.conversationId}
              queuedGroups={inflightRef.current.queuedGroups}
              getResult={getResult}
              settings={transcriptSettings}
              showThinking={showThinking}
            />
          )}
        </div>
      )
    },
    [enteringKey, settlingKey, clearEntering, clearSettling, getResult, transcriptSettings, showThinking, planContext],
  )

  const computeItemKey = useCallback((_index: number, group: DisplayGroup) => stableGroupKey(group), [])

  const emptyContext = useMemo<EmptyContext>(() => ({ emptyKey: cacheKey }), [cacheKey])

  return (
    <div className="flex-1 min-h-0 relative" data-perf-region="transcript-virtuoso">
      {/* A/B spike marker -- subtle so it never distracts, but lets us tell the
          two renderers apart at a glance. Only the Virtuoso path renders it; the
          TanStack path has no badge, so "no badge" == TanStack. */}
      <div
        className="pointer-events-none absolute top-1.5 right-2 z-20 rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-emerald-400/60"
        title="react-virtuoso transcript renderer (experimental A/B). Toggle via Cmd+P."
      >
        virtuoso
      </div>
      <Virtuoso<DisplayGroup, EmptyContext>
        ref={virtuosoRef}
        data={mainGroups}
        context={emptyContext}
        firstItemIndex={firstItemIndex}
        computeItemKey={computeItemKey}
        itemContent={itemContent}
        components={VIRTUOSO_COMPONENTS}
        totalListHeightChanged={handleTotalListHeightChanged}
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
