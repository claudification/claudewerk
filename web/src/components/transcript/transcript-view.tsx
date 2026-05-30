import { projectIdentityKey } from '@shared/project-uri'
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
import type { TranscriptAssistantEntry, TranscriptEntry } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  AskQuestionBanners,
  LinkRequestBanners,
  PermissionBanners,
  SpawnApprovalBanners,
} from '../conversation-detail/conversation-banners'
import { Markdown } from '../markdown'
import { TranscriptEmptyState } from './ghost-peek'
import { CompactedDivider, CompactingBanner, MemoizedGroupView, SkillDivider } from './group-view'
import { type DisplayGroup, useIncrementalGroups } from './grouping'
import { AssistantText } from './item-renderers'
import { ThinkingPill } from './thinking-pill'

/** Content-aware size estimation to minimize layout shift on first render.
 *  Falls back to measuredSizes cache for groups that have been rendered before. */
function estimateGroupSize(group: DisplayGroup, measuredSizes: Map<string, number>, key: string): number {
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

/** Default window start: show the last WINDOW_SIZE entries, or all of them when
 *  the transcript is short enough that windowing buys nothing. */
function defaultWindowStart(len: number): number {
  return len > WINDOW_THRESHOLD ? len - WINDOW_SIZE : 0
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

const EMPTY_STREAMING = ''

/** Thinking block -- renders BEFORE group content (chronological order).
 *  Persists after thinking ends; never cleared during the conversation. */
const StreamingThinkingBlock = memo(function StreamingThinkingBlock({
  conversationId,
}: {
  conversationId: string | null
}) {
  const isActive = useConversationsStore(state =>
    conversationId ? state.conversationsById[conversationId]?.status === 'active' : false,
  )
  const streamingThinking = useConversationsStore(
    state => (conversationId ? state.streamingThinking[conversationId] : null) || EMPTY_STREAMING,
  )
  if (!streamingThinking) return null
  return (
    <div className="mt-2 pl-4">
      <div className="border-l-2 border-purple-400/40 pl-3 py-1">
        <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1">thinking</div>
        <div className="text-sm opacity-60 italic">
          <Markdown>{streamingThinking}</Markdown>
          {isActive && <span className="inline-block w-1.5 h-4 bg-purple-500 animate-pulse ml-0.5 align-text-bottom" />}
        </div>
      </div>
    </div>
  )
})

/** Streaming text -- renders AFTER group content (response being built). Shares
 *  the committed renderer (AssistantText) so the streaming box IS a dimmed,
 *  emerald-accented version of the final text -- no separate "streaming" header,
 *  identical geometry, so the in-place swap to the committed entry doesn't shift.
 *  The settle morph (border/opacity) lives in the committed group's wrapper. */
const StreamingTextBlock = memo(function StreamingTextBlock({ conversationId }: { conversationId: string | null }) {
  const showStreaming = useConversationsStore(state => state.controlPanelPrefs.showStreaming !== false)
  const streamingText = useConversationsStore(
    state => (conversationId ? state.streamingText[conversationId] : null) || EMPTY_STREAMING,
  )
  if (!showStreaming || !streamingText) return null
  return (
    <div className="mt-2">
      <AssistantText text={streamingText} streaming />
    </div>
  )
})

const VERBS = [
  'Thinking',
  'Reasoning',
  'Pondering',
  'Computing',
  'Processing',
  'Analyzing',
  'Cogitating',
  'Ruminating',
  'Deliberating',
  'Contemplating',
  'Synthesizing',
  'Evaluating',
  'Calculating',
  'Deducing',
  'Inferring',
  'Considering',
  'Brainstorming',
  'Formulating',
  'Assembling',
  'Decoding',
  'Untangling',
  'Composing',
  'Orchestrating',
  'Channeling',
  'Manifesting',
  'Conjuring',
  'Brewing',
  'Crafting',
  'Forging',
  'Weaving',
  'Sculpting',
  'Crunching',
  'Finugeling',
  'Machinating',
  'Scheming',
  'Plotting',
]

/** Shows a fun random verb spinner while the conversation is active (between UserPromptSubmit and Stop) */
const ThinkingSpinner = memo(function ThinkingSpinner({ conversationId }: { conversationId: string | null }) {
  const isActive = useConversationsStore(state =>
    conversationId ? state.conversationsById[conversationId]?.status === 'active' : false,
  )
  const totalOutput = useConversationsStore(state =>
    conversationId ? (state.conversationsById[conversationId]?.stats?.totalOutputTokens ?? 0) : 0,
  )
  // Custom verbs: project settings override > conversation verbs (from CC settings) > defaults
  const customVerbs = useConversationsStore(state => {
    const conversation = conversationId ? state.conversationsById[conversationId] : undefined
    const projectVerbs = conversation?.project
      ? state.projectSettings[projectIdentityKey(conversation.project)]?.verbs
      : undefined
    return projectVerbs?.length ? projectVerbs : conversation?.spinnerVerbs
  })
  const verbList = customVerbs?.length ? customVerbs : VERBS

  const [verb, setVerb] = useState(() => VERBS[Math.floor(Math.random() * VERBS.length)])
  const [dots, setDots] = useState(0)
  const baselineRef = useRef(0)

  // Capture baseline when turn starts
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalOutput intentionally omitted - only capture baseline on status transition, not every token update
  useEffect(() => {
    if (isActive) baselineRef.current = totalOutput
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [isActive]) // only on status transition, not on every token update

  const turnTokens = isActive ? Math.max(0, totalOutput - baselineRef.current) : 0

  // biome-ignore lint/correctness/useExhaustiveDependencies: verbList intentionally omitted - stable for conversation duration, re-registering interval on every render unnecessary
  useEffect(() => {
    if (!isActive) return
    const verbInterval = setInterval(() => {
      setVerb(verbList[Math.floor(Math.random() * verbList.length)])
    }, 3000)
    const dotInterval = setInterval(() => {
      setDots(d => (d + 1) % 4)
    }, 400)
    return () => {
      clearInterval(verbInterval)
      clearInterval(dotInterval)
    }
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [isActive])

  if (!isActive) return null

  return (
    <div className="mt-2 flex flex-col items-start px-4 py-1.5 text-[11px] font-mono text-muted-foreground/60">
      <div className="flex items-center gap-2">
        <span className="inline-block size-2 bg-accent rounded-full animate-pulse" />
        <span className="text-accent/70">
          {verb}
          {'.'.repeat(dots)}
        </span>
      </div>
      {turnTokens > 0 && (
        <span className="text-muted-foreground/40 tabular-nums pl-4 text-[10px]">
          {(turnTokens / 1000).toFixed(1)}K tokens
        </span>
      )}
    </div>
  )
})

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

  // Progressive load window (Phase 1a). windowStart is an ABSOLUTE index into
  // `entries`: set to the last-N default on open, only ever REDUCED by "Load
  // earlier". Keeping it fixed during streaming means `windowed` stays a pure
  // tail-append of the previous `windowed`, so grouping stays on the cheap
  // incremental path (resetSignal below only changes on a prepend).
  const [windowStart, setWindowStart] = useState(() => defaultWindowStart(entries.length))
  const prevCacheKeyRef = useRef(cacheKey)
  // True once we've sized the window against a NON-EMPTY transcript for the
  // current cacheKey. A cold switch (MISS) opens the conversation with entries=[]
  // (fetch in flight), so the initial windowStart is 0; without this flag the
  // window would never re-default when the fetched transcript arrives, and a
  // freshly-fetched 460-entry conversation would render ALL of it (measured
  // 340ms commit->paint -- the cold-open bug this fixes).
  const windowInitRef = useRef(entries.length > 0)
  // Derived-state reset (the documented "adjust state on prop change in render"
  // pattern -- re-renders before commit, no flash, no full-render paint):
  if (cacheKey !== prevCacheKeyRef.current) {
    // Conversation switch -- snap to the last-N default for whatever is loaded
    // (0 for a MISS; the real default for a HIT).
    prevCacheKeyRef.current = cacheKey
    windowInitRef.current = entries.length > 0
    setWindowStart(defaultWindowStart(entries.length))
  } else if (!windowInitRef.current && entries.length > 0) {
    // Cold-open transcript just arrived (MISS -> fetch). Size the window now.
    windowInitRef.current = true
    setWindowStart(defaultWindowStart(entries.length))
  } else if (windowStart > 0 && windowStart >= entries.length) {
    // Stale start past a shrunk array (e.g. /clear replacing the transcript).
    setWindowStart(defaultWindowStart(entries.length))
  }
  const windowed = useMemo(() => (windowStart > 0 ? entries.slice(windowStart) : entries), [entries, windowStart])
  // Live windowStart for the scroll handler (infinite scrollback trigger).
  const windowStartRef = useRef(windowStart)
  windowStartRef.current = windowStart

  // Grouping reset signal: identity of the FIRST rendered entry. Changes on a
  // local window reveal (windowStart down) AND a server prepend (windowStart
  // stays 0 but the oldest entry changes) -- both are head-growth that the
  // tail-only incremental path would mis-group. Stays constant during streaming
  // (tail append), so streaming stays incremental.
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

  // Lift settings selectors here (once) instead of per-GroupView (N times)
  const expandAll = useConversationsStore(state => state.expandAll)
  const globalSettings = useConversationsStore(state => state.globalSettings)
  const chatBubbles = useConversationsStore(state => state.controlPanelPrefs.chatBubbles)
  const bubbleColor = useConversationsStore(state => state.controlPanelPrefs.chatBubbleColor) || 'blue'
  const transcriptSettings = useMemo(
    () => ({
      expandAll,
      userLabel: (globalSettings.userLabel as string)?.trim() || 'USER',
      agentLabel: (globalSettings.agentLabel as string)?.trim() || 'CLAUDE',
      userColor: (globalSettings.userColor as string)?.trim() || '',
      agentColor: (globalSettings.agentColor as string)?.trim() || '',
      userSize: (globalSettings.userSize as string) || '',
      agentSize: (globalSettings.agentSize as string) || '',
      chatBubbles,
      bubbleColor,
    }),
    [expandAll, globalSettings, chatBubbles, bubbleColor],
  )

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
  const enterWindowStartRef = useRef(windowStart)
  const tailKey = mainGroups.length > 0 ? stableGroupKey(mainGroups[mainGroups.length - 1]) : null
  const shouldEnter =
    tailKey !== null &&
    tailKey !== prevTailKeyRef.current &&
    prevTailKeyRef.current !== null &&
    cacheKey === enterCacheKeyRef.current &&
    windowStart === enterWindowStartRef.current &&
    // Never animate while a turn is live: the streaming itself is the animation,
    // and the committed entry takes over the live item in place -- a slide-in
    // there would flash/jerk. Genuine new entries while idle still animate.
    !liveActive
  const pendingEnterRef = useRef<string | null>(null)
  if (shouldEnter) pendingEnterRef.current = tailKey
  prevTailKeyRef.current = tailKey
  enterCacheKeyRef.current = cacheKey
  enterWindowStartRef.current = windowStart
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

  // Extract plan content from entries for ExitPlanMode display.
  // Finds the last Write to a plans/*.md path across all entries.
  // IMPORTANT: return stable reference when content hasn't changed to avoid busting memo on all GroupViews.
  const planContextRef = useRef<{ content: string; path?: string } | undefined>(undefined)
  const planContext = useMemo(() => {
    let content: string | undefined
    let path: string | undefined
    for (const entry of entries) {
      if (entry.type !== 'assistant') continue
      const msg = (entry as TranscriptAssistantEntry).message
      if (!msg) continue
      const blocks = msg.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block.type === 'tool_use' && block.name === 'Write' && block.input) {
          const filePath = block.input.file_path as string
          if (filePath && /plans\/[^/]+\.md$/.test(filePath)) {
            content = block.input.content as string
            path = filePath
          }
        }
      }
    }
    const next = content ? { content, path } : undefined
    const prev = planContextRef.current
    if (prev?.content === next?.content && prev?.path === next?.path) return prev
    planContextRef.current = next
    return next
  }, [entries])

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
  const renderGroups = useMemo(
    () => (appendSyntheticLive ? [...mainGroups, LIVE_GROUP] : mainGroups),
    [appendSyntheticLive, mainGroups, LIVE_GROUP],
  )
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
    (index: number) => (index === liveSlotIndex ? liveKey : stableGroupKey(renderGroups[index])),
    [renderGroups, liveSlotIndex, liveKey],
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
    followOnAppend: true,
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

  // Conversation switch: scroll to end + re-enable follow in the parent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer is stable, onReachedBottom is stable
  useLayoutEffect(() => {
    virtualizer.scrollToEnd()
    onReachedBottom?.()
  }, [cacheKey])

  // Re-pin when follow is toggled on (ScrollToBottomButton click).
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer is stable
  useLayoutEffect(() => {
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize is the intentional trigger; virtualizer is stable
  useLayoutEffect(() => {
    if (follow) virtualizer.scrollToEnd()
  }, [totalSize, follow])

  // Re-entrancy guard for the scroll-up auto-trigger.
  const loadingEarlierRef = useRef(false)
  // Re-entrancy guard for the server-side older-history fetch (infinite scrollback).
  const fetchingOlderRef = useRef(false)

  // "Load earlier": prepend a chunk of older entries from the local window.
  // anchorTo:'end' handles scroll stability on prepend natively.
  const loadEarlier = useCallback(() => {
    setWindowStart(s => Math.max(0, s - LOAD_CHUNK))
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
      const nearTop = movedUp && st < LOAD_EARLIER_SCROLL_THRESHOLD
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

  // Follow state signaling: only react to REAL user input (wheel/touch),
  // not programmatic scroll adjustments from the virtualizer's anchor system.
  // Those adjustments can cause small scrollTop changes that the scroll handler
  // misreads as "user scrolled away" -- breaking follow unexpectedly.
  const onUserScrollRef = useRef(onUserScroll)
  onUserScrollRef.current = onUserScroll
  const onReachedBottomRef = useRef(onReachedBottom)
  onReachedBottomRef.current = onReachedBottom
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    let userScrolling = false
    function onWheelOrTouch() {
      userScrolling = true
      requestAnimationFrame(() => {
        userScrolling = false
      })
    }
    function onScroll() {
      const drift = el!.scrollHeight - el!.scrollTop - el!.clientHeight
      if (drift < 40) {
        onReachedBottomRef.current?.()
      } else if (userScrolling && drift > 120) {
        onUserScrollRef.current?.()
      }
    }
    el.addEventListener('wheel', onWheelOrTouch, { passive: true })
    el.addEventListener('touchstart', onWheelOrTouch, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheelOrTouch)
      el.removeEventListener('touchstart', onWheelOrTouch)
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

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
                {/* Committed content. The synthetic live group has none -- it is
                    pure in-flight UI until the committed entry takes it over. */}
                {!isLive && (
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
