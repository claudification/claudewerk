/**
 * TranscriptView - Virtualized transcript renderer.
 * Uses @tanstack/react-virtual for efficient rendering of large transcript streams.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Fragment,
  memo,
  Profiler,
  type ProfilerOnRenderCallback,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { fetchTranscriptBefore, useConversationsStore } from '@/hooks/use-conversations'
import { record } from '@/lib/perf-metrics'
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
import { type DisplayGroup, useIncrementalGroups } from './grouping'
import { detectReportArtifactRelPath } from './grouping/report-artifact'
import { StreamingTextBlock, StreamingThinkingBlock, ThinkingSpinner } from './in-flight-decorations'
import { ThinkingPill } from './thinking-pill'
import { useFollowSignals } from './use-follow-signals'
import { usePlanContext, useTranscriptSettings } from './use-transcript-derivations'

/** Content-aware size estimation to minimize layout shift on first render.
 *  Falls back to measuredSizes cache for groups that have been rendered before. */
function estimateGroupSize(group: DisplayGroup, measuredSizes: Map<string, number>, key: string): number {
  // The scrollback spacer's height is authoritative-by-computation (olderCount *
  // avgPerEntry), NOT by measurement -- bypass the cache so refinements take
  // effect and a stale measured height never sticks.
  if (group.type === 'scrollback_spacer') return group.spacerHeight ?? 0

  const cached = measuredSizes.get(key)
  if (cached !== undefined) return cached

  switch (group.type) {
    case 'live':
      // First-frame estimate only; measureElement reports the real height once
      // the streaming/spinner content renders. Modest so the initial pin is close.
      return 80
    case 'compacted':
      return 40
    case 'compacting':
      return 56
    case 'skill':
      return 44
    case 'system':
      return group.notifications ? 56 : 48
    case 'boot':
      // ~22px per step, plus a small header + padding. Clamp so a very long
      // boot timeline doesn't eat the whole viewport.
      return Math.min(48 + group.entries.length * 22, 400)
    case 'launch':
      return Math.min(48 + group.entries.length * 22, 400)
    case 'shell':
      // Single compact receipt card (open/exit) -- one row plus optional detail.
      return 48
    case 'advisor': {
      // Header row + optional advice text body (virtualizer re-measures anyway).
      const text = (group.entries[0] as { text?: string })?.text ?? ''
      return Math.min(56 + Math.ceil(text.length / 60) * 16, 320)
    }
    case 'user': {
      const entries = group.entries
      let textLen = 0
      for (const entry of entries) {
        const content = (entry as Record<string, unknown>).message as
          | { content?: string | Array<{ type: string; text?: string }> }
          | undefined
        if (typeof content?.content === 'string') textLen += content.content.length
        else if (Array.isArray(content?.content)) {
          for (const b of content.content) {
            if (b.type === 'text' && b.text) textLen += b.text.length
          }
        }
      }
      // Header ~40px + ~20px per 80-char line, clamped
      return Math.max(56, Math.min(40 + Math.ceil(textLen / 80) * 20, 400))
    }
    case 'assistant': {
      let toolCount = 0
      let textLen = 0
      for (const entry of group.entries) {
        const content = (entry as Record<string, unknown>).message as
          | { content?: string | Array<{ type: string; text?: string }> }
          | undefined
        if (!Array.isArray(content?.content)) continue
        for (const b of content.content) {
          if (b.type === 'tool_use') toolCount++
          if (b.type === 'text' && b.text) textLen += b.text.length
        }
      }
      // Base + collapsed tool lines (~52px each) + text lines
      const base = 48
      const toolHeight = toolCount * 52
      const textHeight = Math.ceil(textLen / 80) * 20
      return Math.max(80, Math.min(base + toolHeight + textHeight, 1500))
    }
    default:
      return 120
  }
}

// Per-conversation cache of measured group heights, keyed by conversationId at
// module scope. Phase 1 introduced this to survive the TranscriptView remount
// on every conversation switch. Phase 2 (this commit) DROPPED that remount --
// TranscriptView is kept mounted across switches and the cacheKey prop changes
// instead. The view re-selects the right Map via useMemo([cacheKey]) below.
// Either way, keeping real heights warm across switches lets estimateSize
// return accurate sizes immediately, so the scroll lands without thrashing
// the layout/measure feedback loop that defined the switch-lag beach ball.
const CONV_SIZE_CACHE_MAX = 25
// Inner cap: prevent one long-scrolled conversation from accumulating unbounded
// height entries. At 2000 measured groups the cache is already warm for any
// realistic window; entries beyond this are just dead weight.
const CONV_SIZE_CACHE_INNER_MAX = 2000
const convSizeCaches = new Map<string, Map<string, number>>()

function getConvSizeCache(conversationId: string | null): Map<string, number> {
  if (!conversationId) return new Map()
  const existing = convSizeCaches.get(conversationId)
  if (existing) {
    // LRU bump -- most-recently-used conversation stays warmest.
    convSizeCaches.delete(conversationId)
    convSizeCaches.set(conversationId, existing)
    return existing
  }
  const fresh = new Map<string, number>()
  convSizeCaches.set(conversationId, fresh)
  if (convSizeCaches.size > CONV_SIZE_CACHE_MAX) {
    const oldest = convSizeCaches.keys().next().value
    if (oldest !== undefined) convSizeCaches.delete(oldest)
  }
  return fresh
}

// Progressive transcript loading (Phase 1a). Render only the last WINDOW_SIZE
// entries on open/switch; "Load earlier" prepends LOAD_CHUNK more. Conversations
// at or below WINDOW_THRESHOLD entries render whole (no window, no button) -- the
// lever only matters for long transcripts that grouping collapses into a few
// giant groups (see .claude/docs/plan-progressive-transcript-spike.md).
const WINDOW_SIZE = 50
const WINDOW_THRESHOLD = 80
const LOAD_CHUNK = 100
/** Auto-load older entries when a user scroll-UP brings the viewport within this
 *  many px of the top (infinite scrollback, Phase 1b -- replaces the button). */
const LOAD_EARLIER_SCROLL_THRESHOLD = 400
/** Re-anchor the seq-anchored window forward once the boundary entry drifts to
 *  within this many entries of the pruned head. Keeps a safety buffer above the
 *  live prune line so the anchor entry is never the one pruned (which would pin
 *  windowStart at 0 and reintroduce per-tick regroup thrash). Small relative to
 *  WINDOW_SIZE so the window amortizes ~(WINDOW_SIZE - margin) appends per
 *  re-anchor instead of regrouping on every post-cap tick. */
const WINDOW_REANCHOR_MARGIN = 8

/** Default window start: show the last WINDOW_SIZE entries, or all of them when
 *  the transcript is short enough that windowing buys nothing. */
function defaultWindowStart(len: number): number {
  return len > WINDOW_THRESHOLD ? len - WINDOW_SIZE : 0
}

/** The window boundary as a SEQ rather than an absolute index. Returns the seq
 *  of the entry at the default window start, or null when the transcript is
 *  short enough that no window applies (show all). Anchoring by seq keeps the
 *  window pinned to the same logical entry across a live head-prune. */
function defaultAnchorSeq(entries: TranscriptEntry[]): number | null {
  const idx = defaultWindowStart(entries.length)
  if (idx <= 0) return null
  return entries[idx]?.seq ?? null
}

/** Stable virtualizer key for a group. Prefers the group's reconciled `id`
 *  (assigned by useIncrementalGroups), which is carried across regroups so it is
 *  invariant under BOTH a tail-append (streaming grows the LAST group at its
 *  tail) AND a head-prune/prepend ("Load earlier" grows the boundary group at
 *  its head). The earlier tail-seq key was invariant under prepend only -- it
 *  changed on every streaming tick, remounting the active group's whole subtree
 *  (fresh DiffView/EditDiff mounts, Shiki re-tokenize) every transcript row.
 *  Falls back to the tail seq for batch-built groups that carry no id. */
function stableGroupKey(group: DisplayGroup): string {
  if (group.id) return group.id
  const tail = group.entries[group.entries.length - 1] as { seq?: number; uuid?: string } | undefined
  const id = tail?.seq ?? tail?.uuid ?? group.timestamp
  return `${group.type}-${id}`
}

let lastVirtualItemCount = 0
let lastTotalGroupCount = 0

const onRenderProfile: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration) => {
  record(
    'render',
    id,
    actualDuration,
    `${phase} base=${baseDuration.toFixed(1)}ms visible=${lastVirtualItemCount}/${lastTotalGroupCount}`,
  )
}

/** Records the gap between React's commit and the next browser paint -- where
 *  layout, style recompute and compositing happen. Profiler.actualDuration only
 *  covers the JS commit; on a conversation switch the visible jank is mostly
 *  this post-commit paint, so it needs its own metric. Mirrors the shared
 *  perf-profiler.tsx probe but stays local because the transcript Profiler
 *  carries the extra visible=N/M detail (see onRenderProfile above). */
function CommitPaintProbe({ id, children }: { id: string; children: ReactNode }) {
  const mountedRef = useRef(false)
  useLayoutEffect(() => {
    const phase = mountedRef.current ? 'update' : 'mount'
    mountedRef.current = true
    const t0 = performance.now()
    const handle = requestAnimationFrame(() => {
      record('render', `${id}.commit->paint`, performance.now() - t0, phase)
    })
    return () => cancelAnimationFrame(handle)
  })
  return <Fragment>{children}</Fragment>
}

/** Profiler wraps its children in an extra fiber and runs React's measurement code
 *  on every commit -- meaningful overhead if left on for every user. Only enable it
 *  when the perf monitor is toggled on (controlPanelPrefs.showPerfMonitor). */
function MaybeProfiler({ enabled, id, children }: { enabled: boolean; id: string; children: ReactNode }) {
  if (!enabled) return <Fragment>{children}</Fragment>
  return (
    <Profiler id={id} onRender={onRenderProfile}>
      <CommitPaintProbe id={id}>{children}</CommitPaintProbe>
    </Profiler>
  )
}

interface TranscriptViewProps {
  entries: TranscriptEntry[]
  follow?: boolean
  showThinking?: boolean
  onUserScroll?: () => void
  onReachedBottom?: () => void
  /** Stable key for the module-level grouping + measured-height caches that
   *  survive the conversation-switch remount. Pass the conversationId for the
   *  main transcript view. Omit it for the subagent transcript view so it gets
   *  a per-instance cache instead of colliding with the parent conversation. */
  cacheKey?: string
}

export const TranscriptView = memo(function TranscriptView({
  entries,
  follow = false,
  showThinking = false,
  onUserScroll,
  onReachedBottom,
  cacheKey,
}: TranscriptViewProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  // Latest virtualizer scroll-rect callback (set by observeElementRect below).
  // Held so the visibility-restore effect can re-push the LIVE element size --
  // a backgrounded tab can leave the virtualizer's cached scrollRect stale and
  // no ResizeObserver fires on return when the box didn't actually resize.
  const rectCbRef = useRef<((rect: { width: number; height: number }) => void) | null>(null)

  // Progressive load window (Phase 1a), SEQ-ANCHORED. windowAnchorSeq is the seq
  // of the entry at the window's top boundary; the slice index `windowStart` is
  // DERIVED from it each render. Anchoring by seq (not a raw index) keeps the
  // window pinned to the same logical entry when the live head-prune
  // (TRANSCRIPT_LIVE_CAP in use-websocket-handlers.ts) drops older entries off
  // entries[0]: an absolute index silently slid forward on every post-cap append,
  // flipping windowed[0] -> regroupSignal -> a full cold re-group + virtualizer
  // jump on EVERY streamed tick once a conversation passed 100 entries. The prune
  // only ever drops entries BELOW the boundary, so the anchor entry survives and
  // the derived index just decrements -- windowed stays a pure tail-append and
  // grouping stays on the cheap incremental path. null = no window (show all).
  const [windowAnchorSeq, setWindowAnchorSeq] = useState<number | null>(() => defaultAnchorSeq(entries))
  const prevCacheKeyRef = useRef(cacheKey)
  // True once we've sized the window against a NON-EMPTY transcript for the
  // current cacheKey. A cold switch (MISS) opens the conversation with entries=[]
  // (fetch in flight), so the initial anchor is null; without this flag the
  // window would never re-default when the fetched transcript arrives, and a
  // freshly-fetched 460-entry conversation would render ALL of it (measured
  // 340ms commit->paint -- the cold-open bug this fixes).
  const windowInitRef = useRef(entries.length > 0)
  // Derived slice index: the first entry at or after the anchor seq. A head-prune
  // shrinks this number without moving the boundary entry; a switch/cold-open/
  // load-earlier moves the anchor and so moves this deliberately. Computed before
  // the reset block so the re-anchor branch can read it.
  const windowStart = useMemo(() => {
    if (windowAnchorSeq === null) return 0
    const idx = entries.findIndex(e => (e.seq ?? 0) >= windowAnchorSeq)
    return idx < 0 ? 0 : idx
  }, [entries, windowAnchorSeq])
  // Derived-state reset (the documented "adjust state on prop change in render"
  // pattern -- re-renders before commit, no flash, no full-render paint):
  if (cacheKey !== prevCacheKeyRef.current) {
    // Conversation switch -- snap to the last-N default for whatever is loaded
    // (null for a MISS; the real default anchor for a HIT).
    prevCacheKeyRef.current = cacheKey
    windowInitRef.current = entries.length > 0
    setWindowAnchorSeq(defaultAnchorSeq(entries))
  } else if (!windowInitRef.current && entries.length > 0) {
    // Cold-open transcript just arrived (MISS -> fetch). Size the window now.
    windowInitRef.current = true
    setWindowAnchorSeq(defaultAnchorSeq(entries))
  } else if (
    windowAnchorSeq !== null &&
    entries.length > 0 &&
    (entries[entries.length - 1].seq ?? 0) < windowAnchorSeq
  ) {
    // Anchor slid past the end of a shrunk/replaced array (e.g. /clear creating a
    // new transcript whose seqs are all below the old anchor). Re-default.
    setWindowAnchorSeq(defaultAnchorSeq(entries))
  } else if (
    follow &&
    entries.length > WINDOW_THRESHOLD &&
    (windowAnchorSeq === null || windowStart < WINDOW_REANCHOR_MARGIN)
  ) {
    // The window boundary is at (or has drifted near) the pruned head. Two ways
    // to get here: (a) tail-append + head-prune walked the anchor entry to within
    // WINDOW_REANCHOR_MARGIN of the head; (b) a deep scrollback hit the local top,
    // where loadEarlier sets the anchor to NULL ("show all") -- previously null was
    // excluded here, so the window stayed show-all forever and EVERY post-cap
    // head-prune changed windowed[0] -> regroupSignal -> a full cold regroup on
    // every posted message (observed 2026-06-10). Re-default the anchor forward to
    // the last WINDOW_SIZE so the boundary sits safely above the prune line again.
    // Gated on `follow` (viewport at the bottom) so dropping the now-offscreen
    // older entries is invisible -- and so a scrollback reader, where the prune is
    // deferred and windowStart wouldn't shrink anyway, is never yanked.
    console.debug(
      `[window] re-anchor reason=${windowAnchorSeq === null ? 'post-scrollback-show-all' : 'near-pruned-head'} entries=${entries.length} windowStart=${windowStart} -> last-${WINDOW_SIZE}`,
    )
    setWindowAnchorSeq(defaultAnchorSeq(entries))
  }
  const windowed = useMemo(() => (windowStart > 0 ? entries.slice(windowStart) : entries), [entries, windowStart])
  // Live windowStart for the scroll handler (infinite scrollback trigger).
  const windowStartRef = useRef(windowStart)
  windowStartRef.current = windowStart

  // Grouping reset signal: identity of the FIRST rendered entry. Changes on a
  // local window reveal (anchor moved older) AND a server prepend (anchor null/0
  // but the oldest entry changes) -- both are head-growth that the tail-only
  // incremental path would mis-group. Stays constant during streaming (tail
  // append) AND across a head-prune (the anchor entry survives the prune), so
  // both stay on the cheap incremental path.
  const regroupSignal = windowed.length > 0 ? (windowed[0].seq ?? windowed[0].uuid ?? windowStart) : windowStart
  // More history exists on the server iff our oldest-held entry isn't seq 1.
  const hasMoreOlder = (entries[0]?.seq ?? 1) > 1
  // Live mirrors for the scroll handler (a stable closure that must read latest).
  const hasMoreOlderRef = useRef(hasMoreOlder)
  hasMoreOlderRef.current = hasMoreOlder
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const cacheKeyRef = useRef(cacheKey)
  cacheKeyRef.current = cacheKey

  const { getResult, groups } = useIncrementalGroups(windowed, cacheKey, regroupSignal)

  // Lift the per-group display settings ONCE (shared, virtualizer-agnostic).
  const transcriptSettings = useTranscriptSettings()

  // Split: queued groups float at the bottom, non-queued in the virtualizer
  const { mainGroups, queuedGroups } = useMemo(() => {
    const main: DisplayGroup[] = []
    const queued: DisplayGroup[] = []
    for (const g of groups) {
      if (g.queued) queued.push(g)
      else main.push(g)
    }
    return { mainGroups: main, queuedGroups: queued }
  }, [groups])

  // Live-turn state (drives the live tail item + suppresses the enter animation
  // during streaming so the in-place streaming->committed swap never flashes).
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

  // ENTER ANIMATION -- slide up + fade in the newest group, ONLY for a live new
  // entry. Detected during RENDER (not an effect) so the new row carries the
  // animation class on its FIRST paint -- adding it post-paint would flash the
  // row at full opacity for a frame, then snap back to the start. Verified in a
  // real-browser TanStack harness (.claude/temp/anim-harness): opacity + transform
  // are composited, so the virtualizer's measureElement ResizeObserver never
  // re-fires and scrollTop never moves (pinViolations 0 / jumpToTop 0 / maxDrift
  // 0 across 25 appends). This touches NONE of the scroll/pin logic.
  //
  // Eligibility (all must hold): the LAST group's key changed, the conversation
  // is the same (not a switch), the window is unchanged (not a head prepend /
  // "load earlier"), there was a previous tail (not the first paint of a
  // conversation), and follow is on and not killed (the bottom is in view).
  // ENTER ANIMATION STATE. Uses a post-render effect (not derived-state-in-render)
  // because the virtualizer may not include the new tail row in its visible range
  // on the render where detection fires -- the pin-to-bottom scrolls AFTER paint,
  // then a second render brings the row into view. A ref mutation is invisible to
  // that second render; a state update via useEffect ensures React re-renders with
  // the entering key at a point where the virtualizer has the row visible.
  const [enteringKey, setEnteringKey] = useState<string | null>(null)
  const prevTailKeyRef = useRef<string | null>(null)
  const enterCacheKeyRef = useRef(cacheKey)
  // Track the ANCHOR, not the derived index: a head-prune decrements windowStart
  // without logically moving the window, and that must NOT read as a window change
  // (which would suppress the slide-in for genuine new tail entries).
  const enterWindowAnchorRef = useRef(windowAnchorSeq)
  const tailKey = mainGroups.length > 0 ? stableGroupKey(mainGroups[mainGroups.length - 1]) : null
  const shouldEnter =
    tailKey !== null &&
    tailKey !== prevTailKeyRef.current &&
    prevTailKeyRef.current !== null &&
    cacheKey === enterCacheKeyRef.current &&
    windowAnchorSeq === enterWindowAnchorRef.current &&
    // Never animate while a turn is live: the streaming itself is the animation,
    // and the committed entry takes over the live item in place -- a slide-in
    // there would flash/jerk. Genuine new entries while idle still animate.
    !liveActive
  const pendingEnterRef = useRef<string | null>(null)
  if (shouldEnter) pendingEnterRef.current = tailKey
  prevTailKeyRef.current = tailKey
  enterCacheKeyRef.current = cacheKey
  enterWindowAnchorRef.current = windowAnchorSeq
  // Fire the state update in an effect so it lands AFTER the pin-to-bottom scroll
  // has brought the new row into the virtualizer's visible range.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tailKey is the intentional trigger
  useEffect(() => {
    const key = pendingEnterRef.current
    if (key) {
      pendingEnterRef.current = null
      setEnteringKey(key)
      // console.debug('[transcript-enter] SET', key)
    }
  }, [tailKey])
  const clearEntering = useCallback(() => setEnteringKey(null), [])

  // SETTLE MORPH. When the streaming TEXT buffer clears (a message/turn just
  // committed), the committed assistant entry has taken over the live slot in
  // place. Tag that tail group so its wrapper plays `assistant-settle`
  // (globals.css): the emerald accent bar fades out + opacity rises to full, so
  // the streaming box visibly settles into the final text. Mirrors enteringKey;
  // detected during render off the true->false edge of the text buffer.
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

  // Plan content for ExitPlanMode display (shared, virtualizer-agnostic).
  const planContext = usePlanContext(entries)

  // Subagent state is no longer drilled down as a prop. Each Agent tool row's
  // badge (AgentTaskBadge) and inline-transcript wiring subscribe to their own
  // matching subagent directly, so a subagent poll re-renders only those rows
  // -- not every GroupView. See tool-cases-agent.tsx / tool-line.tsx.

  const perfEnabled = useConversationsStore(state => state.controlPanelPrefs.showPerfMonitor)

  // LIVE TAIL ITEM. The in-flight turn (streaming thinking + text + spinner +
  // thinking-pill) renders INSIDE one persistent virtualizer item so it is part
  // of the virtualizer's totalSize and anchorTo:'end' tracks it. The committed
  // assistant entry then takes over this SAME item (same key + index) in place:
  // no item is appended or removed at completion, so the count never changes and
  // the 80px end-threshold is never tripped -> no jerk, anchor holds.
  const lastMainGroup = mainGroups.length > 0 ? mainGroups[mainGroups.length - 1] : null
  // Append a synthetic live item ONLY while there is no committed assistant group
  // to host the streaming yet (last committed group is the user prompt etc.).
  // Once the committed assistant group exists it IS the live slot -- streaming
  // renders inside it and it keeps the live key, making the synthetic->committed
  // transition an in-place swap (same key/index, no count change).
  const appendSyntheticLive = liveActive && lastMainGroup?.type !== 'assistant'
  const LIVE_GROUP = useMemo<DisplayGroup>(() => ({ type: 'live', timestamp: '', entries: [] }), [])

  // SCROLLBACK SPACER (flag-gated, EXPERIMENTAL). Reserve estimated height for
  // older entries not yet rendered, so the scrollbar reflects the full
  // conversation length. The durable seq is dense-from-1, so the oldest VISIBLE
  // entry's `seq - 1` is exactly the count of unrendered-older entries (both
  // windowed-out AND server-unloaded). Height = that count * a running per-entry
  // average (avgPerEntryRef, refined post-measure each frame). Quantized into a
  // bucket so the memo identity stays stable across sub-pixel avg drift.
  const avgPerEntryRef = useRef(60) // running avg measured group height per entry (px)
  const phantomHeightRef = useRef(0) // current scrollback-spacer height, for the load trigger
  const reserveScrollback = useConversationsStore(state => state.controlPanelPrefs.scrollbackReservation)
  const oldestVisibleSeq = windowed.length > 0 ? (windowed[0].seq ?? 0) : 0
  const olderCount = reserveScrollback && oldestVisibleSeq > 1 ? oldestVisibleSeq - 1 : 0
  const spacerHeight = Math.round(olderCount * avgPerEntryRef.current)
  const spacerBucket = Math.round(spacerHeight / 24)
  // biome-ignore lint/correctness/useExhaustiveDependencies: spacerHeight is intentionally bucketed via spacerBucket to keep the memo identity stable across sub-pixel drift
  const SCROLLBACK_SPACER = useMemo<DisplayGroup | null>(
    () =>
      olderCount > 0
        ? { type: 'scrollback_spacer', timestamp: '', entries: [], spacerHeight, spacerCount: olderCount }
        : null,
    [olderCount, spacerBucket],
  )
  const renderGroups = useMemo(() => {
    const head = SCROLLBACK_SPACER ? [SCROLLBACK_SPACER] : []
    const tail = appendSyntheticLive ? [LIVE_GROUP] : []
    return head.length || tail.length ? [...head, ...mainGroups, ...tail] : mainGroups
  }, [SCROLLBACK_SPACER, appendSyntheticLive, mainGroups, LIVE_GROUP])
  const hasSpacer = !!SCROLLBACK_SPACER
  phantomHeightRef.current = hasSpacer ? spacerHeight : 0
  // [scrollback] diagnostics (flag-gated path): every spacer height transition is
  // a scrollHeight shift the follow gate must absorb -- log it so a misbehaving
  // session shows WHICH layout change drove the scroll events. Bucketed height
  // means this fires on real transitions, not sub-pixel avg drift.
  const prevSpacerHeightRef = useRef(phantomHeightRef.current)
  if (reserveScrollback && phantomHeightRef.current !== prevSpacerHeightRef.current) {
    console.debug(
      `[scrollback] spacer ${prevSpacerHeightRef.current}px -> ${phantomHeightRef.current}px (olderCount=${olderCount} avgPerEntry=${avgPerEntryRef.current.toFixed(1)} windowStart=${windowStart})`,
    )
  }
  prevSpacerHeightRef.current = phantomHeightRef.current
  const spacerKey = selectedConversationId ? `scrollback-${selectedConversationId}` : 'scrollback'
  const liveKey = selectedConversationId ? `live-${selectedConversationId}` : 'live'
  // The live slot is the last renderGroups item while the turn is live, keyed
  // liveKey so the synthetic group and the committed assistant group are the
  // SAME virtualizer item across the transition. When the turn ends it reverts
  // to the group's normal stable key; the seeded height (below) makes that
  // remount invisible (same height -> no scroll shift).
  const liveSlotIndex = liveActive ? renderGroups.length - 1 : -1

  // Cache measured sizes so estimateSize can use real heights for groups that
  // have been rendered before. Sourced from a module-level per-conversation
  // cache. useMemo re-selects the right Map when cacheKey changes (Phase 2 of
  // plan-transcript-switch-perf keeps this component mounted across switches,
  // so the cache binding has to track cacheKey explicitly instead of being
  // captured once on mount).
  const measuredSizes = useMemo(() => getConvSizeCache(cacheKey ?? null), [cacheKey])

  const getItemKey = useCallback(
    (index: number) => {
      if (index === liveSlotIndex) return liveKey
      if (hasSpacer && index === 0) return spacerKey
      return stableGroupKey(renderGroups[index])
    },
    [renderGroups, liveSlotIndex, liveKey, hasSpacer, spacerKey],
  )

  const virtualizer = useVirtualizer({
    count: renderGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: index =>
      index < renderGroups.length ? estimateGroupSize(renderGroups[index], measuredSizes, getItemKey(index)) : 0,
    overscan: 5,
    getItemKey,
    // Chat-mode: end-anchored list with auto-follow. anchorTo:'end' handles
    // prepend stability (scroll offset adjusts to keep the visible item fixed)
    // and streaming growth (size deltas keep the end pinned). followOnAppend
    // auto-scrolls to the end on new items only when already pinned (user
    // scrolled up = no pull-down). Replaces all manual scroll-to-bottom and
    // prepend-anchor machinery.
    anchorTo: 'end',
    // followOnAppend OFF (field experiment): its native scroll-on-append is
    // INSTANT and pre-empts the smooth follow below. With it off, every follow
    // (append AND in-place growth) routes through the single totalSize effect,
    // which animates smoothly once the conversation has settled.
    followOnAppend: false,
    scrollEndThreshold: 80,
    // Safari fix: ResizeObserver can fire mid-layout before paint completes,
    // causing the virtualizer to read intermediate/partial element heights and
    // clip content. Deferring to rAF ensures measurements happen after layout.
    useAnimationFrameWithResizeObserver: true,
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement
      if (!el) return
      rectCbRef.current = cb
      // Seed with the live size so the first range calc has a real viewport
      // instead of waiting on the first ResizeObserver tick (guarded >0).
      const seed = el.getBoundingClientRect()
      if (seed.height > 0) cb({ width: seed.width, height: seed.height })
      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        if (entry) {
          requestAnimationFrame(() => {
            const { width, height } = entry.contentRect
            // NEVER feed a collapsed (0-height) viewport to the virtualizer.
            // virtual-core sets calculateRange() -> [] when outerSize <= 0, so
            // a single 0-height observation (backgrounded tab, display:none
            // pane, or a contentRect captured right before hide whose rAF
            // callback flushes on return) renders the transcript EMPTY except
            // the floating bottom line -- and it stays empty because the cached
            // scrollRect=0 persists until another (non-zero) resize fires, which
            // never comes if the box didn't actually change size. Keep the last
            // good size; a genuine visible resize will update it.
            if (height <= 0) {
              console.debug(`[transcript-rect] ignored 0-height resize ${cacheKey?.slice(0, 8) ?? '-'}`)
              return
            }
            cb({ width, height })
          })
        }
      })
      observer.observe(el)
      return () => {
        rectCbRef.current = null
        observer.disconnect()
      }
    },
  })

  // No supplementary RO needed -- streaming content is inside the last
  // virtualizer group. anchorTo:'end' handles height growth natively.

  // Track measured sizes: visible items have real DOM measurements from ResizeObserver.
  // Cache these so estimateSize returns accurate heights when items re-enter the viewport.
  const virtualItems = virtualizer.getVirtualItems()
  for (const item of virtualItems) {
    measuredSizes.set(String(item.key), item.size)
  }
  // When the committed assistant group IS the live slot (rendered under liveKey),
  // mirror its measured height onto its own stable key. The moment the turn ends
  // and the key reverts liveKey -> stableKey, estimateSize returns this seeded
  // height so the remount keeps the same totalSize -- no scroll shift.
  if (liveActive && !appendSyntheticLive && lastMainGroup) {
    const liveSize = measuredSizes.get(liveKey)
    if (liveSize !== undefined) measuredSizes.set(stableGroupKey(lastMainGroup), liveSize)
  }
  // Inner cap: drop oldest entries (insertion-order) when the per-conversation
  // size cache exceeds CONV_SIZE_CACHE_INNER_MAX. LRU trim keeps recently-visible
  // groups warm while preventing unbounded growth on long scrollback sessions.
  if (measuredSizes.size > CONV_SIZE_CACHE_INNER_MAX) {
    const excess = measuredSizes.size - CONV_SIZE_CACHE_INNER_MAX
    let trimmed = 0
    for (const key of measuredSizes.keys()) {
      measuredSizes.delete(key)
      if (++trimmed >= excess) break
    }
  }
  // Refine the per-entry height average from currently-measured REAL groups
  // (exclude the synthetic spacer + live slot). Drives the scrollback spacer's
  // reserved height; one-frame lag is fine (the spacer is an estimate).
  if (reserveScrollback) {
    let hSum = 0
    let eSum = 0
    for (const g of renderGroups) {
      if (g.type === 'scrollback_spacer' || g.type === 'live' || g.entries.length === 0) continue
      const sz = measuredSizes.get(stableGroupKey(g))
      if (sz !== undefined) {
        hSum += sz
        eSum += g.entries.length
      }
    }
    if (eSum > 0) avgPerEntryRef.current = hSum / eSum
  }

  // Total virtualized height. Also the dependency that drives the pin-to-bottom
  // layout effect below -- it changes only when the virtualizer re-measures
  // rows, i.e. on a real measurement delta.
  const totalSize = virtualizer.getTotalSize()

  // Recover from a stale/collapsed scroll-rect on tab return. While the tab is
  // hidden, rAF is suspended and a 0-height resize can get cached (see the
  // observeElementRect guard above); a ResizeObserver may not fire on return if
  // the element's box is unchanged. Re-push the LIVE element size so outerSize
  // is non-zero and calculateRange() renders the full window again. Belt-and-
  // suspenders for the "empty transcript, only last line on return" bug.
  useEffect(() => {
    function onVisible() {
      if (document.hidden) return
      const el = parentRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      if (r.height > 0) rectCbRef.current?.({ width: r.width, height: r.height })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Manual escape hatch: the reload-transcript chord bumps transcriptRemeasureSeq.
  // Re-push the live element size so a stuck/collapsed virtualizer recovers even
  // while the tab is visible (the visibility handler above won't fire then).
  const transcriptRemeasureSeq = useConversationsStore(state => state.transcriptRemeasureSeq)
  // biome-ignore lint/correctness/useExhaustiveDependencies: transcriptRemeasureSeq is the intentional trigger; the body reads refs/DOM only
  useEffect(() => {
    if (transcriptRemeasureSeq === 0) return
    const el = parentRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.height > 0) rectCbRef.current?.({ width: r.width, height: r.height })
    virtualizer.measure()
  }, [transcriptRemeasureSeq])

  // Start at the latest message (docs pattern). virtualizer.scrollToEnd()
  // sets the virtualizer's internal "at end" state so followOnAppend knows
  // to pin. el.scrollTop = el.scrollHeight does NOT do this.
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer is stable
  useLayoutEffect(() => {
    virtualizer.scrollToEnd()
  }, [virtualizer])

  // Smooth-follow gate. FALSE during the initial post-switch measurement burst so
  // entering/switching a conversation snaps INSTANTLY to the bottom (boom, you're
  // there) -- without this, the totalSize effect below would smooth-crawl through
  // the content as it measures in. Flipped true a beat after settle so subsequent
  // growth (streaming/pills/appends) follows SMOOTHLY.
  const followSmoothRef = useRef(false)
  // Last totalSize, for the growth-only follow guard below. Reset on switch so the
  // first measure of a fresh conversation counts as growth.
  const prevTotalSizeRef = useRef(0)

  // Conversation switch: scroll to end + re-enable follow in the parent. Resets
  // the smooth gate so the entry scroll + initial load stay instant.
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer is stable, onReachedBottom is stable
  useLayoutEffect(() => {
    followSmoothRef.current = false
    prevTotalSizeRef.current = 0
    virtualizer.scrollToEnd()
    onReachedBottom?.()
    console.debug(`[follow] switch-pin cacheKey=${cacheKey?.slice(0, 8) ?? '-'} groups=${renderGroups.length}`)
    // Did the entry actually land at the bottom? (Issue: "entering a conversation
    // doesn't always get to the bottom".) Measure a frame later, after the
    // scrollToEnd + first layout. DID-NOT-REACH means the pin undershot the
    // still-measuring content -- the growth effect below should converge it iff
    // `follow` is true by then.
    const raf = requestAnimationFrame(() => {
      const el = parentRef.current
      if (!el) return
      const drift = el.scrollHeight - el.scrollTop - el.clientHeight
      console.debug(
        `[follow] switch-pin settled drift=${drift.toFixed(0)} ${drift < 40 ? 'OK' : 'DID-NOT-REACH-BOTTOM'} follow=${follow ? 1 : 0}`,
      )
    })
    const id = setTimeout(() => {
      followSmoothRef.current = true
    }, 350)
    return () => {
      clearTimeout(id)
      cancelAnimationFrame(raf)
    }
  }, [cacheKey])

  // Re-pin when follow is toggled on (ScrollToBottomButton click). Logs the
  // authoritative engaged/disengaged transition at the PROP level.
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer is stable
  useLayoutEffect(() => {
    console.debug(`[follow] follow-prop=${follow ? 'ON (engaged)' : 'OFF (disengaged)'}`)
    if (follow) virtualizer.scrollToEnd()
  }, [follow])

  // Re-pin on ANY measured-height change while following. anchorTo:'end' anchors
  // the end against jumps but does NOT actively pull the viewport down when the
  // LAST item grows IN PLACE -- which is exactly what the in-flight bottom UI
  // does: streaming thinking/text, the verb spinner, and the thinking pill all
  // render inside the last virtual item, so no new item is appended and
  // followOnAppend never fires. totalSize captures every such growth (and the
  // shrink when they vanish), so scroll to end to keep the new bottom content
  // visible. Gated on `follow` so a scrolled-up user is never yanked; idempotent
  // when already pinned; stable across the live->committed swap (seeded height
  // keeps totalSize constant there), so it does not fire spuriously.
  // Follow only on GROWTH. On shrink -- in-flight decorations collapsing away --
  // we do NOT scroll: the smooth height-collapse + the browser's own scrollTop
  // clamp settle the content gently, and an extra scrollToEnd here would fight
  // that. prevTotalSizeRef (declared above, reset to 0 on switch) makes the first
  // measure of a fresh conversation count as growth.
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize is the intentional trigger; virtualizer is stable
  const lastGrewLogRef = useRef(0)
  useLayoutEffect(() => {
    const grew = totalSize > prevTotalSizeRef.current
    const delta = totalSize - prevTotalSizeRef.current
    prevTotalSizeRef.current = totalSize
    if (follow && grew) {
      virtualizer.scrollToEnd({ behavior: followSmoothRef.current ? 'smooth' : 'auto' })
    } else if (grew && !follow && delta > 24) {
      // Content arrived (new group, async recap, finished turn) while follow was
      // already OFF, so nothing pins -- the "recap scrolls below / anchor lost"
      // symptom. The preceding DISENGAGE line tells you WHY follow was off.
      // Throttled so streaming-while-reading-history doesn't flood.
      const now = performance.now()
      if (now - lastGrewLogRef.current > 800) {
        lastGrewLogRef.current = now
        console.debug(
          `[follow] grew-but-not-following Δ=${delta.toFixed(0)} total=${totalSize.toFixed(0)} -- content arrived while follow OFF (won't pin)`,
        )
      }
    }
  }, [totalSize, follow])

  // PREPEND STABILITY is native. virtual-core 3.17.0 (`@tanstack/react-virtual`
  // 3.14.2 pins it exactly and passes options straight through) implements
  // `anchorTo:'end'` prepend anchoring: on any count change it captures the item
  // at the current scroll offset (the viewport-top item, keyed by our stable
  // getItemKey) and adjusts scrollOffset BEFORE paint so that item stays visually
  // fixed -- whether following or not. A "Load earlier" window reveal or an
  // infinite-scrollback fetch therefore holds position with zero jerk. We used to
  // ALSO hand-roll a scrollTop+=totalSizeDelta anchor here; running both
  // double-compensated (native pins, then the manual add shoved the view down a
  // full prepend-block, then it settled = the load/jerk/scroll/jerk symptom), so
  // the manual anchor is gone. Native is the sole prepend anchor.

  // Re-entrancy guard for the scroll-up auto-trigger.
  const loadingEarlierRef = useRef(false)
  // Re-entrancy guard for the server-side older-history fetch (infinite scrollback).
  const fetchingOlderRef = useRef(false)
  // True only while the user is actively scrolling (wheel/touch + a short tail for
  // momentum). The load-earlier trigger gates on this so PROGRAMMATIC scrolls --
  // conversation-switch scrollToEnd, the pin effects, the prepend anchor's own
  // scrollTop writes -- can never fire a backfill (which would snowball: switch
  // snaps to top -> load -> over-cap prune storm -> regroup thrash).
  const userScrollingRef = useRef(false)
  const userScrollResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // "Load earlier": prepend a chunk of older entries from the local window.
  // Scroll stability on prepend is handled natively by anchorTo:'end' (see the
  // PREPEND STABILITY note above) -- the count change keeps the viewport-top item
  // pinned, so revealing older entries does not move what you are reading.
  const loadEarlier = useCallback(() => {
    const ents = entriesRef.current
    const newStart = Math.max(0, windowStartRef.current - LOAD_CHUNK)
    // Move the anchor to the newly-revealed boundary entry (null = reached the
    // top, show all). Derived windowStart re-resolves from this on the next render.
    setWindowAnchorSeq(newStart <= 0 ? null : (ents[newStart]?.seq ?? null))
  }, [])

  // Infinite scrollback: fetch older entries from the broker.
  const fetchOlder = useCallback(() => {
    const cid = cacheKeyRef.current
    const oldestSeq = entriesRef.current[0]?.seq
    if (!cid || oldestSeq === undefined || oldestSeq <= 1) return
    fetchingOlderRef.current = true
    fetchTranscriptBefore(cid, oldestSeq, LOAD_CHUNK)
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

  // Scroll handler: auto-load older entries on scroll-up.
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    let lastScrollTop = el.scrollTop
    function handleScroll() {
      if (!el) return
      const st = el.scrollTop
      const movedUp = st < lastScrollTop
      lastScrollTop = st
      // "Near top" = within threshold of the FIRST REAL entry. With the scrollback
      // spacer reserving phantomHeightRef px above real content, the real top is at
      // that offset (not scrollTop 0); subtract it so the load fires as real
      // content approaches the viewport, not after scrolling through the phantom.
      // phantomHeightRef is 0 when the reservation flag is off -> original behavior.
      // Gate on genuine user scrolling: programmatic scrolls (switch, pin,
      // prepend anchor) must never trigger a load, or they snowball.
      const nearTop =
        movedUp && userScrollingRef.current && st - phantomHeightRef.current < LOAD_EARLIER_SCROLL_THRESHOLD
      if (nearTop && windowStartRef.current > 0 && !loadingEarlierRef.current) {
        loadingEarlierRef.current = true
        loadEarlier()
        requestAnimationFrame(() => {
          loadingEarlierRef.current = false
        })
      } else if (nearTop && windowStartRef.current === 0 && hasMoreOlderRef.current && !fetchingOlderRef.current) {
        fetchOlder()
      }
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [loadEarlier, fetchOlder])

  // Follow state signaling (wheel/touch intent + layout-stability gate) lives
  // in use-follow-signals.ts -- see its header for the 2026-06-10 oscillator
  // incident that motivated the suppression logic.
  useFollowSignals({
    parentRef,
    follow,
    onUserScroll,
    onReachedBottom,
    cacheKeyRef,
    loadingEarlierRef,
    fetchingOlderRef,
    userScrollingRef,
    userScrollResetRef,
  })

  const isEmpty = renderGroups.length === 0 && queuedGroups.length === 0

  return (
    <div
      ref={parentRef}
      data-perf-region="transcript"
      className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4"
      style={{ overscrollBehavior: 'contain', touchAction: 'pan-y' }}
    >
      {isEmpty && <TranscriptEmptyState conversationId={cacheKey} />}
      <div
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        <MaybeProfiler enabled={perfEnabled} id="TranscriptGroups">
          {(() => {
            lastVirtualItemCount = virtualItems.length
            lastTotalGroupCount = renderGroups.length
            return virtualItems
          })().map(virtualItem => {
            const itemKey = String(virtualItem.key)
            const isEntering = enteringKey === itemKey
            const isSettling = settlingKey === itemKey
            const isLast = virtualItem.index === renderGroups.length - 1
            const group = renderGroups[virtualItem.index]
            const isLive = group.type === 'live'
            const isSpacer = group.type === 'scrollback_spacer'
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  transform: `translateY(${virtualItem.start}px)`,
                  width: '100%',
                }}
              >
                {/* Scrollback spacer: a pure reserved-height block standing in for
                    older entries not yet rendered. measureElement reads this
                    explicit height; estimateGroupSize returns the same value. */}
                {isSpacer && <div aria-hidden style={{ height: group.spacerHeight ?? 0 }} />}
                {/* Committed content. The synthetic live/spacer groups have none. */}
                {!isLive && !isSpacer && (
                  <div
                    className={cn(isEntering && 'transcript-entry-enter', isSettling && 'assistant-settle')}
                    onAnimationEnd={
                      isEntering || isSettling
                        ? e => {
                            if (e.animationName === 'transcript-entry-enter') clearEntering()
                            else if (
                              e.animationName === 'assistant-settle-bar' ||
                              e.animationName === 'assistant-settle-text'
                            )
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
                        const reportRel = detectReportArtifactRelPath(content)
                        const reportArtifact =
                          reportRel && selectedConversationId
                            ? { conversationId: selectedConversationId, relPath: reportRel }
                            : undefined
                        return (
                          <SkillDivider
                            name={group.skillName || 'skill'}
                            content={content}
                            reportArtifact={reportArtifact}
                          />
                        )
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
                )}
                {/* In-flight UI lives INSIDE the last measured item so totalSize
                    includes it and anchorTo:'end' keeps it pinned. Order is
                    chronological: streaming thinking -> streaming text -> pill
                    -> spinner, then banners + queued. For a continuation turn these
                    render after the committed content above. All of these return
                    null when there is nothing in-flight, so an idle last item
                    renders only its committed content + any pending banners. */}
                {isLast && (
                  <>
                    <StreamingThinkingBlock conversationId={selectedConversationId} />
                    <StreamingTextBlock conversationId={selectedConversationId} />
                    <ThinkingPill conversationId={selectedConversationId} />
                    <ThinkingSpinner conversationId={selectedConversationId} />
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
                            // biome-ignore lint/suspicious/noArrayIndexKey: queued groups may share timestamp
                            key={`queued-${qg.timestamp}-${i}`}
                            group={qg}
                            getResult={getResult}
                            settings={transcriptSettings}
                            showThinking={showThinking}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </MaybeProfiler>
      </div>
    </div>
  )
})
