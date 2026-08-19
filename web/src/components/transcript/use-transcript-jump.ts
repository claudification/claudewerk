/**
 * Land the transcript on ONE entry -- the message the user clicked in
 * transcript search.
 *
 * Shared by both renderers because the hard part is not scrolling, it is
 * getting the target to EXIST first. A search hit can name a seq that is older
 * than anything currently loaded (the client holds a live tail, the FTS index
 * holds everything), and older still than the render window's top boundary. So
 * the jump runs as a small state machine across renders:
 *
 *   1. FETCH   the entry is not in `entries` at all -> pull older pages, one
 *              LOAD_CHUNK per round, until it arrives or we run out of history.
 *   2. REVEAL  the entry is loaded but above the window boundary -> widen the
 *              window down to it (revealSeq).
 *   3. TARGET  the entry is rendered -> hand the renderer its group key and let
 *              it do the scroll, which is the only renderer-specific step.
 *
 * Bounded on purpose: a jump into a 40k-entry conversation must not turn into
 * an unbounded fetch loop, and a seq that simply is not there (a cold archive
 * hit whose conversation was pruned) has to fail quietly rather than spin.
 */

import { useEffect, useRef, useState } from 'react'
import type { TranscriptEntry } from '@/lib/types'
import { stableGroupKey } from './group-content'
import type { DisplayGroup } from './grouping'
import { useJumpFor, useTranscriptJumpStore } from './transcript-jump-store'

/** Max older-page fetches for one jump. LOAD_CHUNK is 50, so this reaches ~1500
 *  entries back -- deep enough for any realistic hit, bounded enough that a
 *  target that does not exist gives up in about a second. */
const MAX_FETCH_ROUNDS = 30

/** How long the landed group stays highlighted. Long enough to catch the eye on
 *  a busy transcript, short enough that it never reads as selection state. */
const HIGHLIGHT_MS = 2200

function groupKeyForSeq(groups: DisplayGroup[], seq: number): string | null {
  for (const group of groups) {
    if (group.entries.some(e => e.seq === seq)) return stableGroupKey(group)
  }
  return null
}

/** True once an entry at or before `seq` is loaded -- i.e. the client holds
 *  history reaching far enough back for the target to be renderable. */
function reachesBackTo(entries: TranscriptEntry[], seq: number): boolean {
  const oldest = entries[0]?.seq
  return oldest !== undefined && oldest <= seq
}

export interface TranscriptJumpTarget {
  /** Group key to scroll to, or null while the jump is still resolving. */
  groupKey: string | null
  /** Group key to paint the landed-here highlight on (outlives `groupKey`,
   *  which clears the moment the renderer consumes it). */
  highlightKey: string | null
  /** Called by the renderer once it has actually scrolled. */
  onLanded: () => void
}

export function useTranscriptJump(opts: {
  cacheKey: string | undefined
  entries: TranscriptEntry[]
  groups: DisplayGroup[]
  hasMoreOlder: boolean
  fetchOlder: () => void
  revealSeq: (seq: number) => void
  /** Pull the view out of follow mode -- landing mid-history while the engine
   *  still wants the bottom would snap straight back down. */
  onLeaveFollow?: () => void
}): TranscriptJumpTarget {
  const { cacheKey, entries, groups, hasMoreOlder, fetchOlder, revealSeq, onLeaveFollow } = opts
  const jump = useJumpFor(cacheKey)
  const [highlightKey, setHighlightKey] = useState<string | null>(null)

  // Per-jump progress, keyed by nonce so a second click on the same hit starts
  // a fresh budget instead of inheriting an exhausted one.
  const progressRef = useRef<{ nonce: number; rounds: number; leftFollow: boolean } | null>(null)
  if (jump && progressRef.current?.nonce !== jump.nonce) {
    progressRef.current = { nonce: jump.nonce, rounds: 0, leftFollow: false }
  }

  const progress = jump ? progressRef.current : null
  const loaded = jump ? reachesBackTo(entries, jump.seq) : false
  const groupKey = jump && loaded ? groupKeyForSeq(groups, jump.seq) : null

  // Step 1/2 run as effects: both mutate state (fetch, window anchor) that the
  // render pass must not touch.
  useEffect(() => {
    if (!jump || !progress) return
    if (!progress.leftFollow) {
      progress.leftFollow = true
      onLeaveFollow?.()
    }
    if (loaded) {
      revealSeq(jump.seq)
      return
    }
    if (!hasMoreOlder) {
      console.warn(`[jump] seq=${jump.seq} is older than the whole transcript -- giving up`)
      useTranscriptJumpStore.getState().clearJump()
      return
    }
    if (progress.rounds >= MAX_FETCH_ROUNDS) {
      console.warn(`[jump] seq=${jump.seq} not reached after ${MAX_FETCH_ROUNDS} pages -- giving up`)
      useTranscriptJumpStore.getState().clearJump()
      return
    }
    progress.rounds += 1
    fetchOlder()
  }, [jump, progress, loaded, hasMoreOlder, fetchOlder, revealSeq, onLeaveFollow])

  // Clear the highlight after its window, per key so a second jump restarts it.
  useEffect(() => {
    if (!highlightKey) return
    const timer = setTimeout(() => setHighlightKey(null), HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlightKey])

  // Drop a pending jump when the user navigates away mid-flight -- honouring it
  // later would yank a conversation they have already left.
  useEffect(() => {
    return () => {
      const pending = useTranscriptJumpStore.getState().jump
      if (pending && pending.conversationId === cacheKey) useTranscriptJumpStore.getState().clearJump()
    }
  }, [cacheKey])

  function onLanded() {
    if (groupKey) setHighlightKey(groupKey)
    useTranscriptJumpStore.getState().clearJump()
  }

  return { groupKey, highlightKey, onLanded }
}
