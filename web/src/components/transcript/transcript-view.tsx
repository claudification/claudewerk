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
import { useConversationsStore } from '@/hooks/use-conversations'
import { record } from '@/lib/perf-metrics'
import type { TranscriptEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import { labSummary, resolveVirtualizerLab } from '@/lib/virtualizer-lab'
import { TranscriptEmptyState } from './ghost-peek'
import { AnimatedGroupContent, stableGroupKey } from './group-content'
import { type DisplayGroup, useIncrementalGroups } from './grouping'
import { BannersBlock, InFlightBlock } from './transcript-bottom'
import { useFollowSignals } from './use-follow-signals'
import { useTailAnimations } from './use-tail-animations'
import { useLiveGroups, usePlanContext, useTranscriptSettings } from './use-transcript-derivations'
import { useTranscriptWindow } from './use-transcript-window'

/** Content-aware size estimation to minimize layout shift on first render.
 *  Falls back to measuredSizes cache for groups that have been rendered before. */
function estimateGroupSize(
  group: DisplayGroup,
  measuredSizes: Map<string, number>,
  key: string,
  liveEstimate: number,
): number {
  // The scrollback spacer's height is authoritative-by-computation (olderCount *
  // avgPerEntry), NOT by measurement -- bypass the cache so refinements take
  // effect and a stale measured height never sticks.
  if (group.type === 'scrollback_spacer') return group.spacerHeight ?? 0

  const cached = measuredSizes.get(key)
  if (cached !== undefined) return cached

  switch (group.type) {
    case 'live':
      // First-frame estimate only; measureElement reports the real height once
      // the streaming/spinner content renders. Modest so the initial pin is
      // close. Lab-tunable: the estimate->measured snap is a residual jump
      // suspect (virtualizerLab.liveEstimate).
      return liveEstimate
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
      // Base + collapsed tool lines (~52px each) + text lines. The cap was
      // 1500 when a group could hold a whole agentic turn; with the seq-bucket
      // group bound (GROUP_SEQ_SPAN) groups are small, so a higher cap lets a
      // genuinely tall markdown entry estimate CLOSE instead of popping
      // +2000px on first measure during scrollback.
      const base = 48
      const toolHeight = toolCount * 52
      const textHeight = Math.ceil(textLen / 80) * 20
      return Math.max(80, Math.min(base + toolHeight + textHeight, 4000))
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

// Progressive transcript loading + infinite scrollback data logic lives in
// use-transcript-window.ts (shared with TranscriptViewPlain).
/** Auto-load older entries when a user scroll-UP brings the viewport within this
 *  many px of the top (infinite scrollback, Phase 1b -- replaces the button). */
const LOAD_EARLIER_SCROLL_THRESHOLD = 400

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

export interface TranscriptViewProps {
  conversationId: string
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
  conversationId,
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

  // Forced group-break seqs, one per backfill boundary. Per-conversation;
  // cleared on switch (the hook signals that with seq=undefined). Mutated in
  // place BEFORE the anchor state change that triggers the regroup, so grouping
  // reads it fresh. Native anchorTo:'end' prepend anchoring is ITEM-granular:
  // it compensates by the anchored item's start shift, so a prepend that MERGES
  // into the head of the reader's (giant) boundary group moves nothing it can
  // see and the content slides under the reader uncompensated (2026-06-10:
  // 8000px slide -> view lands at the top -> nearTop re-fires -> backfill
  // loop). The forced break makes the boundary entry START A NEW GROUP, so
  // prepended entries always form separate items ABOVE the anchored one.
  const backfillBreaksRef = useRef<Set<number>>(null!)
  if (backfillBreaksRef.current === null) backfillBreaksRef.current = new Set()
  const registerBackfillBreak = useCallback((seq: number | undefined) => {
    if (seq === undefined) {
      backfillBreaksRef.current = new Set()
      return
    }
    if (backfillBreaksRef.current.has(seq)) return
    if (backfillBreaksRef.current.size >= 128) backfillBreaksRef.current.clear()
    backfillBreaksRef.current.add(seq)
    console.debug(`[window] backfill-break seq=${seq} (total=${backfillBreaksRef.current.size})`)
  }, [])

  // Progressive load window + infinite scrollback (SEQ-ANCHORED) -- shared data
  // logic, see use-transcript-window.ts for the full incident-history rationale.
  const {
    windowed,
    windowStart,
    windowStartRef,
    windowAnchorSeq,
    regroupSignal,
    hasMoreOlder,
    hasMoreOlderRef,
    entriesRef,
    cacheKeyRef,
    loadEarlier,
    fetchOlder,
    loadingEarlierRef,
    fetchingOlderRef,
  } = useTranscriptWindow({ entries, cacheKey, follow, onBackfillBoundary: registerBackfillBreak })

  const { getResult, groups } = useIncrementalGroups(windowed, cacheKey, regroupSignal, backfillBreaksRef.current)

  // Lift the per-group display settings ONCE (shared, virtualizer-agnostic).
  const transcriptSettings = useTranscriptSettings()

  // Queued/main split + live-turn signal (shared with TranscriptViewPlain).
  const { mainGroups, queuedGroups, liveActive } = useLiveGroups(groups, conversationId)

  // ENTER + SETTLE tail animations -- shared with TranscriptViewPlain; see
  // use-tail-animations.ts for detection rationale + the composited-only
  // verification. Uses a post-render effect (not derived-state-in-render)
  // because the virtualizer may not include the new tail row in its visible
  // range on the render where detection fires.
  const tailKey = mainGroups.length > 0 ? stableGroupKey(mainGroups[mainGroups.length - 1]) : null
  const settleTailGroup = mainGroups.length > 0 ? mainGroups[mainGroups.length - 1] : null
  const { enteringKey, settlingKey, clearEntering, clearSettling } = useTailAnimations({
    conversationId,
    cacheKey,
    tailKey,
    tailType: settleTailGroup?.type ?? null,
    windowAnchorSeq,
    liveActive,
  })

  // Plan content for ExitPlanMode display (shared, virtualizer-agnostic).
  const planContext = usePlanContext(entries)

  // Subagent state is no longer drilled down as a prop. Each Agent tool row's
  // badge (AgentTaskBadge) and inline-transcript wiring subscribe to their own
  // matching subagent directly, so a subagent poll re-renders only those rows
  // -- not every GroupView. See tool-cases-agent.tsx / tool-line.tsx.

  const perfEnabled = useConversationsStore(state => state.controlPanelPrefs.showPerfMonitor)

  // VIRTUALIZER LAB -- per-device experiment knobs (Experiments settings tab,
  // lib/virtualizer-lab.ts). Defaults reproduce production behavior exactly.
  // The stored partial is a stable ref in the prefs object, so the selector is
  // safe; resolve merges defaults for knobs the stored value doesn't carry.
  const storedLab = useConversationsStore(state => state.controlPanelPrefs.virtualizerLab)
  const lab = useMemo(() => resolveVirtualizerLab(storedLab), [storedLab])
  const labRef = useRef(lab)
  labRef.current = lab
  // Name the configuration under test in the device log -- every experiment
  // session's [follow]/[window] lines are meaningless without knowing which
  // knobs were live.
  useEffect(() => {
    const summary = labSummary(lab)
    if (summary) console.debug(`[lab] active experiments: ${summary}`)
  }, [lab])

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
  // With the lab's outside placement the in-flight UI never renders in the last
  // item, so the synthetic host would just be an empty estimated-height item --
  // skip it there.
  const appendSyntheticLive = lab.inFlightPlacement === 'inside' && liveActive && lastMainGroup?.type !== 'assistant'
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
  // AUTO-SPACER for the stuck-short-window case. Infinite scrollback is driven
  // ONLY by a user scroll-up near the top -- which needs a scroll RANGE. When the
  // real (non-spacer) content doesn't fill the viewport yet older history exists
  // (tall screen + the last ~50 entries), scrollHeight == clientHeight, no scroll
  // event can fire, and the older entries are UNREACHABLE (observed live: a
  // 50-entry window over a 358-entry conversation stranded ~290 entries, zero
  // `before=` fetches in the broker log). Reserving phantom height above -- the
  // SAME mechanism as the pref, but auto-engaged only when stuck -- restores a
  // scrollbar so the user can scroll up, which detaches follow and drives the
  // normal backfill. Crucially this is PHANTOM height, not real prepended entries,
  // so it never trips the follow re-anchor (gated on entries.length) or the live
  // head-prune -- unlike auto-fetching real entries while following, which
  // oscillates against both. Latched per-conversation (set true by the measurement
  // effect below, reset on switch) so the spacer shrinks smoothly with olderCount
  // as history loads instead of being yanked mid-scrollback.
  const [fillSpacerActive, setFillSpacerActive] = useState(false)
  const spacerEnabled = reserveScrollback || fillSpacerActive
  const oldestVisibleSeq = windowed.length > 0 ? (windowed[0].seq ?? 0) : 0
  const olderCount = spacerEnabled && oldestVisibleSeq > 1 ? oldestVisibleSeq - 1 : 0
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
  if (spacerEnabled && phantomHeightRef.current !== prevSpacerHeightRef.current) {
    console.debug(
      `[scrollback] spacer ${prevSpacerHeightRef.current}px -> ${phantomHeightRef.current}px (olderCount=${olderCount} avgPerEntry=${avgPerEntryRef.current.toFixed(1)} windowStart=${windowStart} auto=${fillSpacerActive})`,
    )
  }
  prevSpacerHeightRef.current = phantomHeightRef.current
  const spacerKey = conversationId ? `scrollback-${conversationId}` : 'scrollback'
  const liveKey = conversationId ? `live-${conversationId}` : 'live'
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
      index < renderGroups.length
        ? estimateGroupSize(renderGroups[index], measuredSizes, getItemKey(index), lab.liveEstimate)
        : 0,
    overscan: lab.overscan,
    getItemKey,
    // Chat-mode: end-anchored list with auto-follow. anchorTo:'end' handles
    // prepend stability (scroll offset adjusts to keep the visible item fixed)
    // and streaming growth (size deltas keep the end pinned). followOnAppend
    // auto-scrolls to the end on new items only when already pinned (user
    // scrolled up = no pull-down). Replaces all manual scroll-to-bottom and
    // prepend-anchor machinery.
    anchorTo: 'end',
    // followOnAppend OFF by default (field experiment): its native
    // scroll-on-append is INSTANT and pre-empts the manual follow below.
    // Lab-tunable to re-test against the current driver mix.
    followOnAppend: lab.followOnAppend,
    // The native wasAtEnd end-pin (resizeItem) re-pins in-place growth whenever
    // the ESTIMATED distance from the end is within this threshold -- it never
    // reads our follow prop. gateNativePinWhenDetached zeroes it while follow
    // is off so a detached reader can never be dragged to the bottom by a
    // mis-estimated live group (plan-transcript-detached-forced-scroll Step 2).
    scrollEndThreshold: lab.gateNativePinWhenDetached && !follow ? 0 : lab.scrollEndThreshold,
    // isScrolling machinery: affects scroll-direction latching, which gates the
    // above-viewport re-measure compensation (virtual-core 3.17.1/3.17.3).
    // NOTE: both bind when the scroll element attaches -- changes apply after
    // a reload, not live.
    useScrollendEvent: lab.useScrollendEvent,
    isScrollingResetDelay: lab.isScrollingResetDelay,
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

  // Single pin-to-bottom entry point, lab-switchable. 'scrollToEnd' (default)
  // is the virtualizer's item-math target -- it also updates the internal
  // at-end/scrollState the native follow machinery reads, but it aligns to the
  // last ITEM's measured end, which can undershoot content the measurement
  // hasn't caught up with (quirk #4's hypothesized mechanism). 'scrollHeight'
  // writes the exact DOM bottom -- includes everything (lab-outside overlays,
  // late-measuring in-flight UI), but leaves the virtualizer's internal at-end
  // state to be inferred from the resulting scroll event.
  const pinToBottom = useCallback(
    (opts?: { behavior?: 'auto' | 'smooth' }) => {
      if (labRef.current.pinMethod === 'scrollHeight') {
        const el = parentRef.current
        if (el) el.scrollTop = el.scrollHeight
        return
      }
      virtualizer.scrollToEnd(opts)
    },
    [virtualizer],
  )

  // OUTSIDE-PLACEMENT FOLLOW (lab). Content rendered below the measured stack
  // is invisible to totalSize, so neither the native wasAtEnd pin nor the
  // manual growth effect sees it grow -- the exact failure class that put the
  // in-flight UI inside the last item in the first place. When either
  // placement knob is 'outside', observe the outside container and pin on its
  // growth while following. Pins to the DOM scrollHeight regardless of
  // pinMethod: scrollToEnd's item-math target excludes this block by
  // construction, so it would stop above it.
  const outsideActive = lab.inFlightPlacement === 'outside' || lab.bannersPlacement === 'outside'
  const outsideRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(follow)
  followRef.current = follow
  useEffect(() => {
    if (!outsideActive) return
    const el = outsideRef.current
    const scroller = parentRef.current
    if (!el || !scroller) return
    let lastHeight = el.offsetHeight
    const observer = new ResizeObserver(() => {
      const height = el.offsetHeight
      const grew = height > lastHeight
      lastHeight = height
      if (grew && followRef.current) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [outsideActive])

  // Default placement: streaming content is inside the last virtualizer group,
  // so no supplementary observer is needed -- anchorTo:'end' handles height
  // growth natively.

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
  // FROZEN while scrolled back (follow off): the avg swings wildly with the
  // visible group mix (observed 60->357 px/entry in one session), and every
  // swing resizes a 20k-120k px spacer ABOVE the reader -- a scrollHeight
  // earthquake under their feet. While reading history, only olderCount may
  // move the spacer (prepends, compensated by the native anchor); the avg
  // re-calibrates when the user is back at the bottom.
  if (spacerEnabled && follow) {
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

  // AUTO-SPACER latch (see fillSpacerActive above). Measure the REAL content
  // height -- scrollHeight minus the current phantom -- so engaging the spacer
  // can't feed back into its own trigger. When real content doesn't fill the
  // viewport and older history exists, there is no scroll range for the scroll-up
  // gesture, so reserve phantom height above. Latched ON for the conversation
  // (reset on switch, below): olderCount then shrinks the spacer smoothly as
  // history loads, rather than a boolean flip yanking a tall spacer mid-read.
  useEffect(() => {
    if (fillSpacerActive) return
    const el = parentRef.current
    if (!el) return
    const realContent = el.scrollHeight - phantomHeightRef.current
    if (hasMoreOlder && realContent <= el.clientHeight + LOAD_EARLIER_SCROLL_THRESHOLD) {
      console.debug(
        `[scrollback] auto-spacer ON: realContent=${realContent.toFixed(0)} <= viewport=${el.clientHeight}+${LOAD_EARLIER_SCROLL_THRESHOLD} (older history unreachable without a scroll range)`,
      )
      setFillSpacerActive(true)
    }
  }, [totalSize, hasMoreOlder, windowStart, fillSpacerActive])

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
  useLayoutEffect(() => {
    pinToBottom()
  }, [pinToBottom])

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
    // Drop the auto-spacer latch for the new conversation -- the measurement
    // effect re-evaluates it against the incoming content.
    setFillSpacerActive(false)
    pinToBottom()
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
    if (follow) pinToBottom()
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
  const lastGrewLogRef = useRef(0)
  useLayoutEffect(() => {
    const grew = totalSize > prevTotalSizeRef.current
    const delta = totalSize - prevTotalSizeRef.current
    prevTotalSizeRef.current = totalSize
    if (follow && grew && labRef.current.manualGrowthPin) {
      // INSTANT, always. This manual re-pin coexists with native's own end-pin
      // (virtual-core 3.17.2 pins in-place last-item growth). A SMOOTH scroll here
      // chased a target native had already pinned instantly -> visible overshoot
      // every time an in-flight block / streaming text grew or vanished. Both
      // drivers instant to the same bottom = idempotent, no overshoot. (Removing
      // this effect entirely + followOnAppend:true was tried in a18ff1f6 and broke
      // follow badly -> reverted; keep the effect, just drop the smooth animation.)
      // Lab: manualGrowthPin=false runs native wasAtEnd as the SOLE driver.
      pinToBottom({ behavior: 'auto' })
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
  }, [totalSize, follow, pinToBottom])

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

  // True only while the user is actively scrolling (wheel/touch + a short tail for
  // momentum). The load-earlier trigger gates on this so PROGRAMMATIC scrolls --
  // conversation-switch scrollToEnd, the pin effects, the prepend anchor's own
  // scrollTop writes -- can never fire a backfill (which would snowball: switch
  // snaps to top -> load -> over-cap prune storm -> regroup thrash).
  // loadEarlier / fetchOlder / their re-entrancy refs come from
  // useTranscriptWindow above; the break registration rides its
  // onBackfillBoundary callback.
  const userScrollingRef = useRef(false)
  const userScrollResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
                  <AnimatedGroupContent
                    group={group}
                    conversationId={conversationId}
                    getResult={getResult}
                    settings={transcriptSettings}
                    showThinking={showThinking}
                    planContext={planContext}
                    isEntering={isEntering}
                    isSettling={isSettling}
                    clearEntering={clearEntering}
                    clearSettling={clearSettling}
                  />
                )}
                {/* In-flight UI lives INSIDE the last measured item (default) so
                    totalSize includes it and anchorTo:'end' keeps it pinned. For
                    a continuation turn these render after the committed content
                    above; all render null when nothing is in-flight. The lab
                    placement knobs move either block OUTSIDE the virtualizer
                    (below the measured stack) to test whether the in-place
                    resizes of the last item are what trips the end-pin. */}
                {isLast && (
                  <>
                    {lab.inFlightPlacement === 'inside' && <InFlightBlock conversationId={conversationId} />}
                    {lab.bannersPlacement === 'inside' && (
                      <BannersBlock
                        conversationId={conversationId}
                        queuedGroups={queuedGroups}
                        getResult={getResult}
                        settings={transcriptSettings}
                        showThinking={showThinking}
                      />
                    )}
                  </>
                )}
              </div>
            )
          })}
        </MaybeProfiler>
      </div>
      {/* Lab outside placement: content below the measured stack. Part of the
          scroller's scrollHeight but invisible to totalSize -- the outside
          growth observer (above) keeps it pinned while following. */}
      {outsideActive && (
        <div ref={outsideRef}>
          {lab.inFlightPlacement === 'outside' && <InFlightBlock conversationId={conversationId} />}
          {lab.bannersPlacement === 'outside' && (
            <BannersBlock
              conversationId={conversationId}
              queuedGroups={queuedGroups}
              getResult={getResult}
              settings={transcriptSettings}
              showThinking={showThinking}
            />
          )}
        </div>
      )}
    </div>
  )
})
