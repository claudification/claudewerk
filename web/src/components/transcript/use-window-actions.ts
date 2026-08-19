/**
 * The three ways the transcript window moves BACKWARD, split out of
 * use-transcript-window.ts (which owns the anchor state and the derived slice).
 *
 * All three share the same ceremony -- latch the head-hold, register a backfill
 * boundary, arm the prepend anchor, then move the anchor -- and every one of
 * those steps is a documented incident fix, so they belong side by side where
 * the ceremony is obvious rather than buried in the state machine above them.
 *
 *   loadEarlier  reveal a fixed chunk of already-loaded entries (scrollback)
 *   revealSeq    reveal down to a NAMED entry (transcript-search jump)
 *   fetchOlder   pull another page from the broker (infinite scrollback)
 */

import { useCallback } from 'react'
import { fetchTranscriptBefore, useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptEntry } from '@/lib/types'
import { LOAD_CHUNK } from './transcript-window-core'

type Ref<T> = { current: T }

/** Entries of headroom left above a jump target, so it lands with context above
 *  it instead of glued to the top of the rendered stack. */
const REVEAL_HEADROOM = 5

export interface WindowActionDeps {
  entriesRef: Ref<TranscriptEntry[]>
  windowStartRef: Ref<number>
  cacheKeyRef: Ref<string | undefined>
  fetchingOlderRef: Ref<boolean>
  onBackfillBoundaryRef: Ref<((seq: number | undefined) => void) | undefined>
  onBeforePrependRef: Ref<(() => void) | undefined>
  markHeadHeld: () => void
  setWindowAnchorSeq: (seq: number | null) => void
}

export function useWindowActions(deps: WindowActionDeps) {
  const {
    entriesRef,
    windowStartRef,
    cacheKeyRef,
    fetchingOlderRef,
    onBackfillBoundaryRef,
    onBeforePrependRef,
    markHeadHeld,
    setWindowAnchorSeq,
  } = deps

  /** Move the window boundary to entry index `newStart` (0 = show all). Shared
   *  by both reveal paths -- they differ only in how they pick the index. */
  const anchorAt = useCallback(
    (newStart: number) => {
      const ents = entriesRef.current
      markHeadHeld()
      onBackfillBoundaryRef.current?.(ents[windowStartRef.current]?.seq)
      onBeforePrependRef.current?.()
      setWindowAnchorSeq(newStart <= 0 ? null : (ents[newStart]?.seq ?? null))
    },
    [entriesRef, windowStartRef, onBackfillBoundaryRef, onBeforePrependRef, markHeadHeld, setWindowAnchorSeq],
  )

  const loadEarlier = useCallback(() => {
    anchorAt(Math.max(0, windowStartRef.current - LOAD_CHUNK))
  }, [anchorAt, windowStartRef])

  const revealSeq = useCallback(
    (seq: number) => {
      const idx = entriesRef.current.findIndex(e => (e.seq ?? 0) >= seq)
      if (idx < 0) return // not loaded yet -- the caller fetches older first
      if (idx >= windowStartRef.current) return // already inside the window
      console.debug(`[jump] reveal seq=${seq} windowStart ${windowStartRef.current} -> ${idx - REVEAL_HEADROOM}`)
      anchorAt(Math.max(0, idx - REVEAL_HEADROOM))
    },
    [anchorAt, entriesRef, windowStartRef],
  )

  const fetchOlder = useCallback(() => {
    const cid = cacheKeyRef.current
    const oldestSeq = entriesRef.current[0]?.seq
    if (!cid || oldestSeq === undefined || oldestSeq <= 1) return
    markHeadHeld()
    // The current oldest entry becomes a backfill boundary -- fetched entries
    // prepend ABOVE it.
    onBackfillBoundaryRef.current?.(oldestSeq)
    fetchingOlderRef.current = true
    fetchTranscriptBefore(cid, oldestSeq, LOAD_CHUNK)
      .then(res => {
        if (res && res.entries.length > 0) {
          // Arm the prepend anchor at the moment of insertion, not at fetch
          // start -- content may have streamed in below during the round-trip.
          onBeforePrependRef.current?.()
          useConversationsStore.getState().prependTranscript(cid, res.entries)
        }
        fetchingOlderRef.current = false
      })
      .catch(() => {
        fetchingOlderRef.current = false
      })
  }, [cacheKeyRef, entriesRef, fetchingOlderRef, onBackfillBoundaryRef, onBeforePrependRef, markHeadHeld])

  return { loadEarlier, revealSeq, fetchOlder }
}
