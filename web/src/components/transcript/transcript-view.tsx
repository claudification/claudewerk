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
import { ThinkingPill } from './thinking-pill'

/** Content-aware size estimation to minimize layout shift on first render.
 *  Falls back to measuredSizes cache for groups that have been rendered before. */
function estimateGroupSize(group: DisplayGroup, measuredSizes: Map<string, number>, key: string): number {
  const cached = measuredSizes.get(key)
  if (cached !== undefined) return cached

  switch (group.type) {
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

/** Isolated streaming text component - subscribes to its own store slice so token updates don't re-render the virtualizer */
const StreamingBlock = memo(function StreamingBlock({ conversationId }: { conversationId: string | null }) {
  const showStreaming = useConversationsStore(state => state.controlPanelPrefs.showStreaming !== false)
  const streamingText = useConversationsStore(
    state => (conversationId ? state.streamingText[conversationId] : null) || EMPTY_STREAMING,
  )
  const streamingThinking = useConversationsStore(
    state => (conversationId ? state.streamingThinking[conversationId] : null) || EMPTY_STREAMING,
  )
  if (!showStreaming || (!streamingText && !streamingThinking)) return null
  return (
    <div className="mt-2 pl-4 space-y-2">
      {streamingThinking && (
        <div className="border-l-2 border-purple-400/40 pl-3 py-1">
          <div className="text-[10px] text-purple-400/70 uppercase font-bold tracking-wider mb-1">thinking</div>
          <div className="text-sm opacity-60 italic">
            <Markdown>{streamingThinking}</Markdown>
            <span className="inline-block w-1.5 h-4 bg-purple-500 animate-pulse ml-0.5 align-text-bottom" />
          </div>
        </div>
      )}
      {streamingText && (
        <div className="border-l-2 border-emerald-400/40 pl-3 py-1">
          <div className="text-[10px] text-emerald-400/70 uppercase font-bold tracking-wider mb-1">streaming</div>
          <div className="text-sm opacity-75">
            <Markdown>{streamingText}</Markdown>
            <span className="inline-block w-1.5 h-4 bg-emerald-500 animate-pulse ml-0.5 align-text-bottom" />
          </div>
        </div>
      )}
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
  const followKilledRef = useRef(false)
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
    windowStart === enterWindowStartRef.current
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

  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const perfEnabled = useConversationsStore(state => state.controlPanelPrefs.showPerfMonitor)

  // Count pending permissions for the selected conversation. Used as a scroll-to-bottom
  // trigger so a newly-arrived permission pins into view when follow is active.
  const pendingPermissionCount = useConversationsStore(state =>
    state.selectedConversationId
      ? state.pendingPermissions.filter(p => p.conversationId === state.selectedConversationId).length
      : 0,
  )

  // Pending project-link requests: both inbound (ALLOW/BLOCK) and outbound (waiting)
  const pendingLinkCount = useConversationsStore(state =>
    state.selectedConversationId
      ? state.pendingProjectLinks.filter(
          r =>
            r.toConversation === state.selectedConversationId ||
            (r.fromConversation === state.selectedConversationId && r.toConversation !== state.selectedConversationId),
        ).length
      : 0,
  )

  // Pending ask questions for the selected conversation -- scroll trigger
  const pendingAskCount = useConversationsStore(state =>
    state.selectedConversationId
      ? state.pendingAskQuestions.filter(q => q.conversationId === state.selectedConversationId).length
      : 0,
  )

  // Cache measured sizes so estimateSize can use real heights for groups that
  // have been rendered before. Sourced from a module-level per-conversation
  // cache. useMemo re-selects the right Map when cacheKey changes (Phase 2 of
  // plan-transcript-switch-perf keeps this component mounted across switches,
  // so the cache binding has to track cacheKey explicitly instead of being
  // captured once on mount).
  const measuredSizes = useMemo(() => getConvSizeCache(cacheKey ?? null), [cacheKey])

  const getItemKey = useCallback((index: number) => stableGroupKey(mainGroups[index]), [mainGroups])

  const virtualizer = useVirtualizer({
    count: mainGroups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: index => estimateGroupSize(mainGroups[index], measuredSizes, getItemKey(index)),
    overscan: 5,
    getItemKey,
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

  // Track measured sizes: visible items have real DOM measurements from ResizeObserver.
  // Cache these so estimateSize returns accurate heights when items re-enter the viewport.
  const virtualItems = virtualizer.getVirtualItems()
  for (const item of virtualItems) {
    measuredSizes.set(String(item.key), item.size)
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

  useEffect(() => {
    if (follow) followKilledRef.current = false
  }, [follow])

  // Phase 2 reset on conversation switch.
  //
  // Before Phase 2 the parent passed `key={selectedConversationId}` to this
  // component, so every switch unmounted + remounted -- which gave us scroll
  // position, follow-killed state, and the planContext ref all reset to fresh
  // values "for free", at the cost of a 200-1100ms layout-thrash cascade as
  // the virtualizer re-measured every row from cold (see
  // .claude/docs/plan-transcript-switch-perf.md for the root cause and the
  // Safari Timeline evidence). Phase 2 drops the remount and keeps this
  // component mounted across switches; cacheKey changes instead.
  //
  // That means anything the unmount used to discard for free has to be
  // discarded here explicitly:
  //
  //   - followKilledRef: "user scrolled away" intent is per-conversation. If
  //     A had follow killed (user scrolled up to read history) and we switch
  //     to B where follow=true, B must NOT inherit A's killed state -- the
  //     pin-to-bottom layout effect below checks this ref before re-pinning.
  //
  //   - parentRef.current.scrollTop: the scroll container survives the
  //     switch. Without an explicit snap, B opens at whatever scrollTop A had
  //     last (e.g. 500px into a transcript B doesn't even have that tall).
  //     Snap to bottom when follow is on (matches the steady-state UX), to
  //     top when not (matches the old post-remount initial state, and lets
  //     the user scroll without fighting an unrelated offset).
  //
  // useLayoutEffect runs after commit but before paint, so the snap happens
  // in the same frame -- no flash of the wrong scroll position. The
  // totalSize-keyed effect below then fine-tunes once the virtualizer
  // measures real row heights (typically within the same paint, sometimes a
  // few frames later for off-screen rows).
  //
  // planContextRef is intentionally NOT reset here: its useMemo recomputes on
  // the new entries array, and the previous-vs-next content check naturally
  // returns the new conversation's plan (or undefined). No leak.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow is read at switch time only; we don't want this to re-fire when follow alone toggles (the [follow] effect above handles that)
  useLayoutEffect(() => {
    followKilledRef.current = false
    // Drop any in-flight prepend anchor from the OLD conversation -- the new
    // one's mainGroups don't share keys with it, and we're about to set
    // scrollTop explicitly below.
    prependAnchorRef.current = null
    anchorAppliedRef.current = false
    const el = parentRef.current
    if (!el) return
    if (follow) el.scrollTop = el.scrollHeight
    else el.scrollTop = 0
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [cacheKey])

  // Pin-to-bottom on dynamic measurement. When the virtualizer re-measures rows
  // after first paint and totalSize changes, re-pin in ONE write -- and only if
  // actually drifted from the bottom. Replaces the old scrollToBottom rAF poll
  // loop (3 blind scrollTop writes per call, scrollHeight polled every frame)
  // that pumped a scroll-event feedback loop into the virtualizer and cost
  // 200-1100ms per switch. See .claude/docs/plan-transcript-switch-perf.md.
  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize is an intentional trigger dep -- the effect re-pins when the virtualizer's measured total changes; it is not read in the body
  useLayoutEffect(() => {
    if (!follow || followKilledRef.current) return
    const el = parentRef.current
    if (!el) return
    const t0 = performance.now()
    const drift = el.scrollHeight - el.scrollTop - el.clientHeight
    if (drift > 4) {
      el.scrollTop = el.scrollHeight
      record('scroll', 'scrollRepin', performance.now() - t0, `drift ${drift.toFixed(0)}px`)
    }
  }, [totalSize, follow])

  // Scroll-anchor for prepend ("Load earlier" + infinite scrollback ?before=).
  //
  // Old approach (scrollHeight-delta): on the FIRST layout effect after a
  // prepend commit, shift scrollTop by `newSH - prevSH` then clear the pending
  // flag. Worked for local "Load earlier" because those groups were already in
  // the measuredSizes cache -- one settle pass and done. Broke for server
  // prepends: new groups land with estimateSize() placeholders, ResizeObserver
  // later reports real heights (often 5-10x for tool results), totalSize
  // changes again, but pending was already cleared -- no correction -- content
  // above the viewport silently grew/shrank and the user saw a hop. Multiple
  // off-screen settles compounded into the "massive jerk up/down."
  //
  // New approach (index re-pin): capture the group at the viewport TOP before
  // prepend (its stableGroupKey + the pixel offset of scrollTop within it).
  // After every commit, find the same group by key, read its measurement.start
  // from the virtualizer, and set scrollTop = start + offsetWithinItem. Idempotent
  // (skips writes when already at target) and survives any number of height-
  // settle re-renders. Released on real user input (wheel/touch/keydown) AFTER
  // the anchor has been applied at least once -- so the wheel that TRIGGERED
  // the fetch doesn't immediately abandon the anchor it just set.
  const prependAnchorRef = useRef<{ key: string; offsetWithinItem: number } | null>(null)
  const anchorAppliedRef = useRef(false)
  // Re-entrancy guard for the scroll-up auto-trigger: set when a prepend is
  // kicked off, cleared here once scrollTop has been corrected (moved away from
  // the top), so a burst of scroll events can't fire multiple loads per chunk.
  const loadingEarlierRef = useRef(false)
  // Re-entrancy guard for the server-side older-history fetch (infinite scrollback).
  const fetchingOlderRef = useRef(false)
  // Live mirrors so capture/release callbacks (stable closures) read current.
  const mainGroupsRef = useRef(mainGroups)
  mainGroupsRef.current = mainGroups
  const virtualizerRef = useRef(virtualizer)
  virtualizerRef.current = virtualizer

  const captureAnchor = useCallback(() => {
    const el = parentRef.current
    const v = virtualizerRef.current
    const groups = mainGroupsRef.current
    if (!el || !v) return
    const items = v.getVirtualItems()
    if (items.length === 0) return
    const scrollTop = el.scrollTop
    // The item whose tail is past the viewport top = the one containing it.
    const head = items.find(it => it.end > scrollTop) ?? items[0]
    const g = groups[head.index]
    if (!g) return
    prependAnchorRef.current = {
      key: stableGroupKey(g),
      offsetWithinItem: scrollTop - head.start,
    }
    anchorAppliedRef.current = false
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: totalSize is the intentional trigger; mainGroups + virtualizer are read for the re-pin lookup
  useLayoutEffect(() => {
    const el = parentRef.current
    const anchor = prependAnchorRef.current
    if (!anchor || !el) return
    const t0 = performance.now()
    const newIdx = mainGroups.findIndex(g => stableGroupKey(g) === anchor.key)
    if (newIdx < 0) {
      // Anchor group merged or disappeared in regroup -- can't re-pin safely.
      prependAnchorRef.current = null
      anchorAppliedRef.current = false
      loadingEarlierRef.current = false
      return
    }
    const m = virtualizer.measurementsCache[newIdx]
    if (!m) return
    const target = m.start + anchor.offsetWithinItem
    if (Math.abs(el.scrollTop - target) > 1) {
      el.scrollTop = target
      record('scroll', 'prependAnchor', performance.now() - t0, `idx ${newIdx}`)
    }
    anchorAppliedRef.current = true
    loadingEarlierRef.current = false
  }, [totalSize, windowStart, mainGroups])

  // Release the anchor on real user scroll input -- but only AFTER it has been
  // applied at least once. The wheel/touch that triggered the fetch is itself
  // user input; releasing on it would defeat the anchor before the prepend
  // even lands.
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const release = () => {
      if (!anchorAppliedRef.current) return
      prependAnchorRef.current = null
      anchorAppliedRef.current = false
    }
    el.addEventListener('wheel', release, { passive: true })
    el.addEventListener('touchstart', release, { passive: true })
    el.addEventListener('keydown', release)
    return () => {
      el.removeEventListener('wheel', release)
      el.removeEventListener('touchstart', release)
      el.removeEventListener('keydown', release)
    }
  }, [])

  // "Load earlier": prepend a chunk of older entries. Kill follow (this is an
  // explicit history action) so the pin-to-bottom effect stands down, capture
  // the viewport-top anchor so the layout effect can re-pin across settles.
  const loadEarlier = useCallback(() => {
    followKilledRef.current = true
    captureAnchor()
    setWindowStart(s => Math.max(0, s - LOAD_CHUNK))
  }, [captureAnchor])

  // Infinite scrollback past the locally-held window: fetch the next OLDER page
  // from the broker (?before=) and prepend it to the store. The store array
  // grows at the head; windowStart stays 0 so the fetched page renders, and the
  // anchor captured here lets the layout effect re-pin scrollTop across the
  // multi-phase height-settle that follows. Only for the main transcript view
  // (cacheKey set), never subagents.
  const fetchOlder = useCallback(() => {
    const cid = cacheKeyRef.current
    const oldestSeq = entriesRef.current[0]?.seq
    if (!cid || oldestSeq === undefined || oldestSeq <= 1) return
    fetchingOlderRef.current = true
    followKilledRef.current = true
    captureAnchor()
    fetchTranscriptBefore(cid, oldestSeq, LOAD_CHUNK)
      .then(res => {
        if (res && res.entries.length > 0) {
          useConversationsStore.getState().prependTranscript(cid, res.entries)
        } else {
          // Empty response -- no prepend will happen, drop the anchor.
          prependAnchorRef.current = null
        }
        fetchingOlderRef.current = false
      })
      .catch(() => {
        prependAnchorRef.current = null
        fetchingOlderRef.current = false
      })
  }, [captureAnchor])

  const killFollow = useCallback(
    (e: React.WheelEvent | React.TouchEvent) => {
      if (!follow) return
      if ('deltaY' in e && e.deltaY >= 0) return
      followKilledRef.current = true
      onUserScroll?.()
    },
    [follow, onUserScroll],
  )

  useEffect(() => {
    const el = parentRef.current
    if (!el || follow) return
    // Seed with the position at attach time so the programmatic open snap
    // (scrollTop -> 0 on a follow=false open) is NOT seen as a user scroll-up.
    let lastScrollTop = el.scrollTop
    function handleScroll() {
      if (!el) return
      const st = el.scrollTop
      const movedUp = st < lastScrollTop
      lastScrollTop = st
      // Infinite scrollback: a genuine user scroll-UP into the top band reveals
      // more history. `movedUp` gates out the open snap + scroll-down; the guards
      // + the post-correction scrollTop shift (away from top) prevent a cascade.
      const nearTop = movedUp && st < LOAD_EARLIER_SCROLL_THRESHOLD
      if (nearTop && windowStartRef.current > 0 && !loadingEarlierRef.current) {
        // Phase 1b: locally-held older entries -- reveal instantly, no network.
        loadingEarlierRef.current = true
        loadEarlier()
      } else if (nearTop && windowStartRef.current === 0 && hasMoreOlderRef.current && !fetchingOlderRef.current) {
        // Phase 2: local window exhausted -- page older history from the broker.
        fetchOlder()
      }
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
      if (atBottom) onReachedBottom?.()
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [follow, onReachedBottom, loadEarlier, fetchOlder])

  // Scroll to bottom: a single write. The dynamic-measurement settle (rows
  // measuring taller than estimated after first paint) is handled by the
  // totalSize-keyed layout effect above -- NOT by an rAF poll loop. scrollTop
  // is set against scrollHeight (the whole scroll container, including the
  // streaming + banner region below the virtualizer), so the true bottom is
  // pinned, not just the last virtualized row.
  const scrollToBottom = useCallback(() => {
    if (followKilledRef.current) return
    const el = parentRef.current
    if (!el) return
    // Explicit jump-to-bottom -- release any pending prepend anchor so the
    // layout effect doesn't immediately yank us back.
    prependAnchorRef.current = null
    anchorAppliedRef.current = false
    const t0 = performance.now()
    el.scrollTop = el.scrollHeight
    record('scroll', 'scrollToBottom', performance.now() - t0, 'single write')
  }, [])

  // Subscribe to selected conversation's transcript changes for scroll-to-bottom.
  // IMPORTANT: track the transcript array REFERENCE for the selected conversation, not the global
  // newDataSeq counter. newDataSeq increments for ANY conversation's data (events, transcripts),
  // which caused scrollToBottom -> virtualizer.scrollToIndex -> TranscriptView re-render on
  // every store update from any conversation. By comparing the specific transcript reference,
  // we only scroll when the viewed conversation's data actually changes.
  const followRef = useRef(follow)
  followRef.current = follow
  useEffect(() => {
    const getTranscriptRef = (state: {
      selectedConversationId: string | null
      transcripts: Record<string, unknown>
    }) => (state.selectedConversationId ? state.transcripts[state.selectedConversationId] : undefined)
    let lastRef = getTranscriptRef(useConversationsStore.getState())

    return useConversationsStore.subscribe(state => {
      const current = getTranscriptRef(state)
      if (current !== lastRef) {
        lastRef = current
        if (followRef.current && !followKilledRef.current) scrollToBottom()
      }
    })
  }, [scrollToBottom])

  // Scroll to bottom on initial mount, follow toggle, and entry count changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: entries.length is used as a dep key to trigger scroll on new entries, not to access entries directly
  useEffect(() => {
    if (!follow) return
    // Delay slightly to allow virtualizer to process new items and measure
    const timer = setTimeout(scrollToBottom, 50)
    return () => clearTimeout(timer)
  }, [follow, entries.length, scrollToBottom])

  // Also scroll to bottom when a new pending permission arrives -- permissions
  // render after the virtualized content as a blocking UI gate, so the user
  // needs to see them immediately when follow is active.
  useEffect(() => {
    if (!follow) return
    if (pendingPermissionCount === 0) return
    const timer = setTimeout(scrollToBottom, 50)
    return () => clearTimeout(timer)
  }, [follow, pendingPermissionCount, scrollToBottom])

  // Same for link requests -- when another conversation asks to link, pin the
  // inline approve/block card into view if follow is active.
  useEffect(() => {
    if (!follow) return
    if (pendingLinkCount === 0) return
    const timer = setTimeout(scrollToBottom, 50)
    return () => clearTimeout(timer)
  }, [follow, pendingLinkCount, scrollToBottom])

  // Same for ask questions -- pin the interactive card into view.
  useEffect(() => {
    if (!follow) return
    if (pendingAskCount === 0) return
    const timer = setTimeout(scrollToBottom, 50)
    return () => clearTimeout(timer)
  }, [follow, pendingAskCount, scrollToBottom])

  if (mainGroups.length === 0 && queuedGroups.length === 0) {
    // Ghost (unattached daemon worker) -> live peek + attach. Else NO TRANSCRIPT.
    // cacheKey is the conversationId for the main transcript view.
    return <TranscriptEmptyState conversationId={cacheKey} />
  }

  return (
    <div
      ref={parentRef}
      data-perf-region="transcript"
      className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4"
      style={{ overscrollBehavior: 'contain', touchAction: 'pan-y' }}
      onWheel={killFollow}
      onTouchStart={killFollow}
    >
      {/* Infinite scrollback (Phase 1b): older entries auto-prepend on scroll-up
          (see the scroll handler) -- no button. The synchronous scroll-anchor
          keeps the viewport pinned across the prepend. */}
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
            lastTotalGroupCount = mainGroups.length
            return virtualItems
          })().map(virtualItem => {
            const itemKey = String(virtualItem.key)
            const isEntering = enteringKey === itemKey
            // if (isEntering) console.debug('[transcript-enter] CLASS-APPLIED', itemKey)
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {/* Enter animation lives on an INNER element: the outer div owns the
                    virtualizer's positioning transform, and opacity/transform here are
                    composited so measureElement still reads the final box height. */}
                <div
                  className={isEntering ? 'transcript-entry-enter' : undefined}
                  onAnimationEnd={
                    isEntering
                      ? e => {
                          if (e.animationName === 'transcript-entry-enter') clearEntering()
                        }
                      : undefined
                  }
                >
                  {(() => {
                    const group = mainGroups[virtualItem.index]
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
          })}
        </MaybeProfiler>
      </div>
      {/* Streaming/queued region: wrapped in its own Profiler so perf reports
          attribute stream-delta re-renders correctly (they used to fall outside
          TranscriptGroups and silently cost frames). */}
      <MaybeProfiler enabled={perfEnabled} id="TranscriptStreaming">
        {/* Headless streaming text - isolated component so token updates don't re-render the virtualizer */}
        <StreamingBlock conversationId={selectedConversationId} />
        {/* Live thinking-token pill: ephemeral, renders only while pings arrive.
            Sits ABOVE the verb spinner so the thinking phase reads top-to-bottom. */}
        <ThinkingPill conversationId={selectedConversationId} />
        {/* Fun verb spinner while conversation is working */}
        <ThinkingSpinner conversationId={selectedConversationId} />
        {/* Pending permission + link requests: rendered inline at the bottom as
            blocking UI gates. Both follow the same pattern -- structured wire
            message -> store -> inline banner -> user response over WS. */}
        <div className="mt-2">
          <LinkRequestBanners />
          <PermissionBanners />
          <SpawnApprovalBanners />
          <AskQuestionBanners />
        </div>
        {/* Queued messages: rendered inline at the bottom of the transcript */}
        {queuedGroups.length > 0 && (
          <div className="mt-2 border-t border-dashed border-amber-500/30 pt-2">
            <div className="text-[10px] font-mono text-amber-500/60 px-1 mb-1">QUEUED</div>
            {queuedGroups.map((group, i) => (
              <MemoizedGroupView
                // biome-ignore lint/suspicious/noArrayIndexKey: queued groups may share timestamp, index disambiguates
                key={`queued-${group.timestamp}-${i}`}
                group={group}
                getResult={getResult}
                settings={transcriptSettings}
                showThinking={showThinking}
              />
            ))}
          </div>
        )}
      </MaybeProfiler>
    </div>
  )
})
