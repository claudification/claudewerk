/**
 * CC's message queue, as transcript groups.
 *
 * `queue-operation` entries say a message the user typed mid-turn was held
 * (`enqueue`) and later taken (`remove` / `dequeue` / `popAll`). A held message
 * renders with the amber `queued` badge and is hoisted to the bottom rail, so
 * the flag has to name EXACTLY the messages still waiting.
 *
 * ## Flag the existing bubble, never synthesise a second one
 *
 * Headless emits an optimistic user entry the moment it writes to CC's stdin
 * (stream-backend `sendUserMessage`), so by the time `enqueue` arrives from the
 * JSONL the bubble already exists -- flagging it is the only way to avoid
 * rendering the message twice. PTY/daemon have no optimistic entry, find no
 * match, and get a synthetic queued group instead.
 *
 * The search covers ALL user groups and ALL of each group's entries, never just
 * `entries[0]` of the most recent (both are real 2026-07-22/23 incidents): two
 * messages queued back-to-back used to merge into one group, and an interrupt
 * writes a `[Request interrupted by user]` row that merges AHEAD of the real
 * message. Either way the text sits at a non-zero index.
 *
 * ## `queued` is per MESSAGE, and a group can hold several
 *
 * The flag lives on the group, which was fine until a group held a queued
 * message next to one that was not. Then the badge -- and the hoist to the
 * bottom rail -- applied to the whole merged bubble, so a batch of messages read
 * as "all queued" when only the last one was waiting (Jonas, 2026-07-28). Two
 * rules keep it honest, and both are load-bearing:
 *
 *   1. Flagging SPLITS the group around the enqueued entry, so the flag lands on
 *      that message alone (`splitOutQueuedEntry` below).
 *   2. A queued group is CLOSED to further merges, so the next message starts a
 *      fresh group instead of inheriting the badge (enforced at the merge site
 *      in process-entry.ts -- the split cannot defend itself against a later
 *      append).
 */

import type { TranscriptEntry, TranscriptUserEntry } from '@/lib/types'
import { isQueue, parseTaskNotifications } from './parsers'
import type { DisplayGroup, GroupingState } from './types'

/** Index of the entry in this user group whose content is exactly this string,
 *  or -1. Only string content: an optimistic echo is always a bare string. */
function indexOfText(g: DisplayGroup, content: string): number {
  return g.entries.findIndex(e => {
    const c = (e as TranscriptUserEntry).message?.content
    return typeof c === 'string' && c === content
  })
}

/** Does any user group already render this text via ARRAY content (joined text
 *  blocks)? The dup-canary: flagging only matches string content, so an array
 *  copy of the same text would slip past and get a duplicate synthetic. */
function userGroupHasArrayText(content: string, state: GroupingState): boolean {
  for (const g of state.groups) {
    if (g.type !== 'user') continue
    for (const e of g.entries) {
      const c = (e as TranscriptUserEntry).message?.content
      if (!Array.isArray(c)) continue
      const text = c.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
      if (text === content) return true
    }
  }
  return false
}

/**
 * Replace `state.groups[gi]` with up to three groups so that ONLY the entry at
 * `ei` carries `queued`. A single-entry group is flagged in place.
 *
 * Groups are replaced rather than mutated: a currently-rendering React tree must
 * not be disturbed mid-commit (React #300). `state.current` follows to the LAST
 * piece so the run continues where it left off -- and when that piece is the
 * queued one, rule 2 above stops the next message merging into it.
 */
function splitOutQueuedEntry(state: GroupingState, gi: number, ei: number): void {
  const g = state.groups[gi]
  const parts: DisplayGroup[] = []
  const push = (entries: TranscriptEntry[], queued: boolean) => {
    parts.push({
      ...g,
      entries,
      timestamp: entries[0]?.timestamp || g.timestamp,
      queued,
      // Only the first piece keeps the group's own header; the rest continue it.
      ...(parts.length > 0 ? { continuation: true } : {}),
    })
  }

  if (ei > 0) push(g.entries.slice(0, ei), false)
  push([g.entries[ei]], true)
  if (ei < g.entries.length - 1) push(g.entries.slice(ei + 1), false)

  state.groups.splice(gi, 1, ...parts)
  if (state.current === g) state.current = parts[parts.length - 1]
}

/**
 * Flag the message matching `content` as queued, wherever it already renders.
 * Returns false only when the text is present in NO user group.
 */
function flagExistingUserGroupAsQueued(content: string, state: GroupingState): boolean {
  for (let gi = state.groups.length - 1; gi >= 0; gi--) {
    const g = state.groups[gi]
    if (g.type !== 'user') continue
    const ei = indexOfText(g, content)
    if (ei < 0) continue
    splitOutQueuedEntry(state, gi, ei)
    return true
  }
  return false
}

/** Task-notifications are enqueued too but are fire-and-forget: they render
 *  inline immediately and their dequeue may never arrive, so they must not float
 *  in the queued rail waiting for a drain that never comes. */
function pushTaskNotification(entry: TranscriptEntry, content: string, state: GroupingState): void {
  const notifications = parseTaskNotifications(content)
  if (notifications.length === 0) return
  state.current = null
  state.groups.push({ type: 'system', timestamp: entry.timestamp || '', entries: [entry], notifications })
}

/** A message CC held that we cannot find a bubble for -- the PTY/daemon case,
 *  which has no optimistic echo. */
function pushSyntheticQueued(entry: TranscriptEntry, content: string, state: GroupingState): void {
  // Canary: if a group holds the SAME text as ARRAY content (an interrupted
  // turn, a resend), this synthetic is a DUPLICATE that string matching can't
  // dedup. Warn so a recurrence is greppable in devtools. (Console only -- a
  // popped-out window has no console; routing client diag over WS to the broker
  // is tracked separately.)
  if (userGroupHasArrayText(content, state)) {
    console.warn('[queue] synthesising a queued bubble whose text already renders as array content -- likely dup', {
      preview: content.slice(0, 60),
      groups: state.groups.length,
    })
  }
  const synthetic: TranscriptUserEntry = {
    type: 'user',
    timestamp: entry.timestamp,
    message: { role: 'user', content },
  }
  state.current = { type: 'user', timestamp: entry.timestamp || '', entries: [synthetic], queued: true }
  state.groups.push(state.current)
}

/** Clear the queued flag on the oldest queued group -- or on every one of them
 *  for `popAll`, the only operation that drains more than the head. */
function clearQueued(state: GroupingState, all: boolean): void {
  for (let gi = 0; gi < state.groups.length; gi++) {
    const g = state.groups[gi]
    if (!g.queued) continue
    const cleared: DisplayGroup = { ...g, queued: false }
    state.groups[gi] = cleared
    if (state.current === g) state.current = cleared
    if (!all) return
  }
}

/** Apply one `queue-operation` entry to the grouping state. */
export function handleQueue(entry: TranscriptEntry, state: GroupingState): void {
  if (!isQueue(entry)) return
  if (entry.operation === 'enqueue' && entry.content) {
    const content = entry.content
    if (content.startsWith('<task-notification>')) pushTaskNotification(entry, content, state)
    else if (!flagExistingUserGroupAsQueued(content, state)) pushSyntheticQueued(entry, content, state)
    return
  }
  // CC drains via `dequeue` (taken straight away, never actually held),
  // `remove` (held, then folded into a running turn) or `popAll`.
  if (entry.operation === 'remove' || entry.operation === 'dequeue' || entry.operation === 'popAll') {
    clearQueued(state, entry.operation === 'popAll')
  }
}
