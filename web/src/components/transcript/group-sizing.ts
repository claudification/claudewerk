/**
 * How tall is a group before we have rendered it?
 *
 * Shared by BOTH transcript renderers, for the same underlying reason: a wrong
 * reserved height is a layout shift waiting to happen.
 *  - TanStack `TranscriptView` feeds this to the virtualizer's `estimateSize`.
 *  - `TranscriptViewPlain` feeds it to each group's `contain-intrinsic-size`,
 *    which is the height a `content-visibility: auto` box occupies while its
 *    contents are skipped. A flat estimate there is the scroll-back jump
 *    amplifier: the box inflates to its real height exactly as the reader
 *    scrolls up toward it, shoving everything below it down.
 *
 * Two layers, in order:
 *  1. `measuredSizes` -- real heights recorded from previously-rendered groups,
 *     per conversation, at module scope so they survive a renderer remount.
 *     `contain-intrinsic-size: auto` remembers a real height too, but ONLY for
 *     a live DOM node; a conversation switch destroys those nodes, so this
 *     cache is what makes a switch back land without a settle storm.
 *  2. A content-derived estimate from the group's shape (tool count, text
 *     length, entry count). Coarse, but within the right order of magnitude
 *     instead of an order out.
 *
 * Extracted VERBATIM from transcript-view.tsx (the numbers are device-tuned --
 * see the per-case comments) so the plain renderer stops duplicating a worse
 * flat guess.
 */

import type { DisplayGroup } from './grouping'

/** Fallback for the synthetic live group when no lab override is supplied. */
const DEFAULT_LIVE_ESTIMATE = 80

/** Content-aware size estimation to minimize layout shift on first render.
 *  Falls back to measuredSizes cache for groups that have been rendered before. */
// The per-type table IS the group taxonomy; splitting it hides the numbers.
// fallow-ignore-next-line complexity
export function estimateGroupSize(
  group: DisplayGroup,
  measuredSizes: Map<string, number>,
  key: string,
  liveEstimate: number = DEFAULT_LIVE_ESTIMATE,
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
      // Header ~40px + ~20px per 80-char line, clamped
      return Math.max(56, Math.min(40 + Math.ceil(textLength(group) / 80) * 20, 400))
    }
    case 'assistant': {
      // Base + collapsed tool lines (~52px each) + text lines. The cap was
      // 1500 when a group could hold a whole agentic turn; with the seq-bucket
      // group bound (GROUP_SEQ_SPAN) groups are small, so a higher cap lets a
      // genuinely tall markdown entry estimate CLOSE instead of popping
      // +2000px on first measure during scrollback.
      const base = 48
      const toolHeight = toolUseCount(group) * 52
      const textHeight = Math.ceil(textLength(group) / 80) * 20
      return Math.max(80, Math.min(base + toolHeight + textHeight, 4000))
    }
    default:
      return 120
  }
}

type MessageContent = { content?: string | Array<{ type: string; text?: string }> } | undefined

function messageOf(entry: unknown): MessageContent {
  return (entry as Record<string, unknown>).message as MessageContent
}

/** Total characters of `text` content across a group's entries. */
function textLength(group: DisplayGroup): number {
  let total = 0
  for (const entry of group.entries) {
    const content = messageOf(entry)?.content
    if (typeof content === 'string') total += content.length
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) total += block.text.length
      }
    }
  }
  return total
}

function toolUseCount(group: DisplayGroup): number {
  let count = 0
  for (const entry of group.entries) {
    const content = messageOf(entry)?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') count++
    }
  }
  return count
}

// Per-conversation cache of measured group heights, keyed by conversationId at
// module scope. Phase 1 introduced this to survive the TranscriptView remount
// on every conversation switch. Phase 2 DROPPED that remount -- TranscriptView
// is kept mounted across switches and the cacheKey prop changes instead. The
// view re-selects the right Map via useMemo([cacheKey]). Either way, keeping
// real heights warm across switches lets the estimate return accurate sizes
// immediately, so the scroll lands without thrashing the layout/measure
// feedback loop that defined the switch-lag beach ball.
const CONV_SIZE_CACHE_MAX = 25
// Inner cap: prevent one long-scrolled conversation from accumulating unbounded
// height entries. At 2000 measured groups the cache is already warm for any
// realistic window; entries beyond this are just dead weight.
const CONV_SIZE_CACHE_INNER_MAX = 2000
const convSizeCaches = new Map<string, Map<string, number>>()

export function getConvSizeCache(conversationId: string | null | undefined): Map<string, number> {
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

/** Drop the oldest entries once one conversation's cache passes the inner cap
 *  (insertion order == oldest first). */
export function trimConvSizeCache(measuredSizes: Map<string, number>): void {
  if (measuredSizes.size <= CONV_SIZE_CACHE_INNER_MAX) return
  const excess = measuredSizes.size - CONV_SIZE_CACHE_INNER_MAX
  let dropped = 0
  for (const key of measuredSizes.keys()) {
    measuredSizes.delete(key)
    if (++dropped >= excess) break
  }
}
