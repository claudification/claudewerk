/**
 * Transcript grouping public API: builds display groups from raw transcript
 * entries. Per-entry classification + per-group-type sub-handlers live in
 * grouping/process-entry.ts; this file holds the result map, the batch +
 * incremental drivers, and the React hook.
 */

import { useCallback, useMemo, useRef } from 'react'
import { record } from '@/lib/perf-metrics'
import type { TranscriptEntry } from '@/lib/types'
import { isUser } from './grouping/parsers'
import { applyPlanModeTags, processEntry } from './grouping/process-entry'
import type { DisplayGroup, GroupingState, TaskNotification } from './grouping/types'

// Tail-stable group identity. Same convention as TranscriptView's
// stableGroupKey: keyed on the group's LAST entry (seq -> uuid -> timestamp)
// so a HEAD prepend that grows a boundary group at its head doesn't change
// the key. Used by the identity-preserving regroup below.
function groupIdentityKey(group: DisplayGroup): string {
  const tail = group.entries[group.entries.length - 1] as { seq?: number; uuid?: string } | undefined
  const id = tail?.seq ?? tail?.uuid ?? group.timestamp
  return `${group.type}-${id}`
}

function entriesPointEqual(a: TranscriptEntry[], b: TranscriptEntry[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// Two groups carry the SAME rendered content iff their identifying fields and
// their entries arrays point-equal. Notifications are compared by reference
// (not deep) -- they're rebuilt fresh on every reset, so the rare
// notifications-bearing system group accepts a re-render; the 99% case
// (assistant/user/system without notifications) hits the fast path.
function groupShallowEqual(a: DisplayGroup, b: DisplayGroup): boolean {
  return (
    a.type === b.type &&
    a.timestamp === b.timestamp &&
    a.queued === b.queued &&
    a.planMode === b.planMode &&
    a.skillName === b.skillName &&
    a.systemSubtype === b.systemSubtype &&
    a.localCommandOutput === b.localCommandOutput &&
    a.notifications === b.notifications &&
    entriesPointEqual(a.entries, b.entries)
  )
}

// Re-export so existing call sites (`import { DisplayGroup } from '../grouping'`) keep working.
export type { DisplayGroup, TaskNotification }

// Build map of tool_use_id -> result
export function buildResultMap(entries: TranscriptEntry[]) {
  const map = new Map<string, { result: string; extra?: Record<string, unknown>; isError?: boolean }>()
  for (const entry of entries) {
    if (!isUser(entry)) continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        map.set(block.tool_use_id, {
          result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          extra: entry.toolUseResult as Record<string, unknown> | undefined,
          isError: block.is_error === true,
        })
      }
    }
  }
  return map
}

// Group consecutive entries by role, filtering out noise
export function groupEntries(entries: TranscriptEntry[]): DisplayGroup[] {
  const state: GroupingState = { groups: [], current: null, pendingSkillName: undefined }
  for (const entry of entries) {
    processEntry(entry, state)
  }
  applyPlanModeTags(state.groups)
  return state.groups
}

type ResultEntry = { result: string; extra?: Record<string, unknown>; isError?: boolean }

interface GroupingCache {
  len: number
  resultMap: Map<string, ResultEntry>
  groups: DisplayGroup[]
  lastGroup: DisplayGroup | null
  pendingSkillName?: string
  /** Reference of the entries array last seen -- distinguishes an append
   *  (same array, grown) from a full HTTP refetch (replaced array). */
  lastEntries: TranscriptEntry[] | null
}

function freshGroupingCache(): GroupingCache {
  return { len: 0, resultMap: new Map(), groups: [], lastGroup: null, pendingSkillName: undefined, lastEntries: null }
}

// Module-level per-conversation grouping cache. Phase 1 (commit 05d3862e)
// introduced this so the cache could survive the TranscriptView remount on
// conversation switch -- a per-instance useRef started cold every time and
// forced a full re-group of the whole transcript per switch. Phase 2 (this
// commit) DROPPED the remount; TranscriptView is now kept mounted across
// switches and the cacheKey prop changes instead. The hook below detects a
// cacheKey change during render and swaps cacheRef.current to the new
// conversation's cache. LRU bump on every fetch keeps the most-recently-used
// conversation warmest.
const GROUPING_CACHE_MAX = 25
const groupingCaches = new Map<string, GroupingCache>()

function getGroupingCache(key: string): GroupingCache {
  const existing = groupingCaches.get(key)
  if (existing) {
    // LRU bump -- most-recently-used conversation stays warmest.
    groupingCaches.delete(key)
    groupingCaches.set(key, existing)
    return existing
  }
  const fresh = freshGroupingCache()
  groupingCaches.set(key, fresh)
  if (groupingCaches.size > GROUPING_CACHE_MAX) {
    const oldest = groupingCaches.keys().next().value
    if (oldest !== undefined) groupingCaches.delete(oldest)
  }
  return fresh
}

// Incremental grouping hook: only processes new entries since last call.
// Transcript entries are append-only (except initial load which replaces all).
// IMPORTANT: returns new array/map references each time to avoid mutating
// data that React components are currently rendering (React error #300).
//
// `cacheKey` selects a module-level cache. Pass the conversationId for the
// main transcript view -- the hook detects cacheKey changes during render
// and swaps cacheRef.current to the matching cache (so switching back into
// an already-grouped conversation hits the incremental fast path). Omit it
// (e.g. the subagent transcript view, which renders different entries while
// selectedConversationId still points at the parent) to fall back to a
// per-instance cache and avoid colliding with the parent conversation.
// `resetSignal` (optional): when its value changes between renders, the next
// grouping pass is forced to fully re-group from scratch instead of taking the
// incremental tail-append path. Progressive transcript loading passes the window
// start index here -- a window prepend grows the entries array at the HEAD, which
// the incremental path (slice(cache.len) == tail) would mis-group. Streaming
// (window start unchanged) leaves the signal stable, so tail append stays
// incremental. Undefined for callers that never window (e.g. subagent view).
export function useIncrementalGroups(entries: TranscriptEntry[], cacheKey?: string | null, resetSignal?: unknown) {
  // Per-instance fallback used when cacheKey is null/undefined (no shared
  // cache slot to point at). Created lazily and reused across renders of the
  // same hook instance, so a keyless view (e.g. subagent transcript) is
  // still incremental within its own lifetime.
  const localCacheRef = useRef<GroupingCache | null>(null)
  const cacheRef = useRef<GroupingCache | null>(null)
  const lastCacheKeyRef = useRef<string | null | undefined>(undefined)
  const lastResetSignalRef = useRef<unknown>(resetSignal)
  // Run swap during render so the useMemo below reads the right cache. This
  // is a read of a stable module-level Map; idempotent and safe in render.
  if (cacheRef.current === null || cacheKey !== lastCacheKeyRef.current) {
    if (cacheKey) {
      cacheRef.current = getGroupingCache(cacheKey)
    } else {
      if (!localCacheRef.current) localCacheRef.current = freshGroupingCache()
      cacheRef.current = localCacheRef.current
    }
    lastCacheKeyRef.current = cacheKey
  }

  const groups = useMemo(() => {
    const cache = cacheRef.current as GroupingCache
    if (!Array.isArray(entries)) return cache.groups
    const t0 = performance.now()

    // Window prepend (or any caller-signalled change): force a full re-group.
    // The incremental path assumes new entries land at the tail; a head-prepend
    // violates that.
    const signalChanged = resetSignal !== lastResetSignalRef.current
    lastResetSignalRef.current = resetSignal

    // Full reset if entries shrunk OR array was replaced entirely (HTTP refetch)
    // OR the caller signalled a window change.
    const isReset =
      signalChanged || entries.length < cache.len || (entries !== cache.lastEntries && entries.length <= cache.len)
    cache.lastEntries = entries
    // Snapshot the previous groups BEFORE the wipe -- the reset path rebuilds
    // every group object from scratch, which by itself busts MemoizedGroupView's
    // memo on every visible row (50+ Markdown/Shiki/DOM redos per scroll-up).
    // We use this snapshot below to identity-preserve groups whose entries are
    // unchanged after the regroup, so React's memo can keep them mounted.
    const prevGroups = isReset ? cache.groups : null
    if (isReset) {
      cache.len = 0
      cache.resultMap = new Map()
      cache.groups = []
      cache.lastGroup = null
      cache.pendingSkillName = undefined
    }

    // Nothing new - return stable references. Record an explicit cache-hit
    // sample so a warm switch-back is visible in the perf tab -- otherwise the
    // absence of any incrementalGroup entry is ambiguous (did grouping skip,
    // or did the module cache miss and re-group cold?).
    if (entries.length === cache.len) {
      record('grouping', 'incrementalGroup', performance.now() - t0, `cache hit, ${cache.groups.length} groups, 0 new`)
      return cache.groups
    }

    // Process only the new entries
    const newEntries = entries.slice(cache.len)
    cache.len = entries.length

    // Incremental buildResultMap - clone before mutating so existing renders aren't affected
    const newResultMap = new Map(cache.resultMap)
    for (const entry of newEntries) {
      if (!isUser(entry)) continue
      const content = entry.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          newResultMap.set(block.tool_use_id, {
            result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            extra: entry.toolUseResult as Record<string, unknown> | undefined,
            isError: block.is_error === true,
          })
        }
      }
    }
    cache.resultMap = newResultMap

    // Incremental groupEntries - clone groups + lastGroup before mutating so
    // currently-rendering React trees aren't disturbed (React error #300).
    const newGroups = [...cache.groups]
    let lastGroup = cache.lastGroup
    if (lastGroup && newGroups.length > 0) {
      lastGroup = { ...lastGroup, entries: [...lastGroup.entries] }
      newGroups[newGroups.length - 1] = lastGroup
    }

    // Drive the shared classifier with our cloned state. processEntry mutates
    // state.current so we read it back afterward to refresh cache.lastGroup.
    const state: GroupingState = {
      groups: newGroups,
      current: lastGroup,
      pendingSkillName: cache.pendingSkillName,
    }
    for (const entry of newEntries) {
      processEntry(entry, state)
    }
    lastGroup = state.current
    cache.pendingSkillName = state.pendingSkillName

    // On initial/reset load, clear any orphaned queued flags. Historical data
    // may have enqueue entries whose remove/dequeue was evicted from the 500-entry
    // ring buffer, leaving stale "queued" groups that will never be consumed.
    if (isReset) {
      for (const g of newGroups) {
        if (g.queued) g.queued = false
      }
    }

    // Identity-preserving regroup: on a reset (HEAD prepend, window reveal,
    // refetch) compare each freshly-built group against the prior cache by
    // tail-stable key + content equality. When the content didn't change, swap
    // the new group object out for the prior reference. MemoizedGroupView wraps
    // GroupView in memo() with default shallow comparison -- preserving the
    // reference makes it skip render entirely. Without this, every scroll-up
    // prepend rebuilds every visible group's Markdown / Shiki / DOM tree
    // (~50 rows x heavy content = the "renders EVERYTHING" feel). The orphan-
    // queued clear above runs FIRST so a previously-orphaned-then-cleared prev
    // group matches the freshly-cleared new group on `queued`. Runs only on
    // isReset paths -- the incremental tail-append path naturally preserves
    // identity for all groups except the last one (which gets a fresh clone
    // above so React isn't disturbed mid-render).
    let preservedGroupRefs = 0
    if (isReset && prevGroups && prevGroups.length > 0) {
      const prevByKey = new Map<string, DisplayGroup>()
      for (const g of prevGroups) prevByKey.set(groupIdentityKey(g), g)
      for (let i = 0; i < newGroups.length; i++) {
        const prev = prevByKey.get(groupIdentityKey(newGroups[i]))
        if (prev && groupShallowEqual(prev, newGroups[i])) {
          newGroups[i] = prev
          preservedGroupRefs++
        }
      }
    }

    cache.groups = newGroups
    cache.lastGroup = lastGroup
    const elapsed = performance.now() - t0
    record(
      'grouping',
      'incrementalGroup',
      elapsed,
      `${newEntries.length} entries -> ${newGroups.length} groups${isReset ? ` (RESET cold re-group, ${preservedGroupRefs} refs preserved)` : ''}`,
    )
    if (elapsed > 5 || newEntries.length > 10) {
      console.log(`[grouping] ${newEntries.length} new entries -> ${newGroups.length} groups (${elapsed.toFixed(1)}ms)`)
    }
    return newGroups
  }, [entries, resetSignal])

  // Stable lookup function -- never changes identity, reads from the ref's live Map
  const getResult = useCallback((id: string) => cacheRef.current?.resultMap.get(id), [])

  return { getResult, groups }
}
