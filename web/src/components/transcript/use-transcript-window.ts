/**
 * Progressive transcript window + infinite scrollback data logic, shared by
 * BOTH transcript renderers (TanStack `TranscriptView` and
 * `TranscriptViewPlain`). Extracted from transcript-view.tsx -- the logic is
 * renderer-agnostic (it manages WHICH entries are rendered, not how), and the
 * plain renderer must not duplicate it.
 *
 * The window is SEQ-ANCHORED: `windowAnchorSeq` is the seq of the entry at the
 * window's top boundary; the slice index `windowStart` is DERIVED each render.
 * Anchoring by seq keeps the window pinned to the same logical entry when the
 * live head-prune (TRANSCRIPT_LIVE_CAP, use-websocket-handlers.ts) drops older
 * entries off entries[0]: an absolute index slid forward on every post-cap
 * append -> regroupSignal flip -> full cold re-group + viewport jump per
 * streamed tick (2026-05-31 incident). The prune only drops entries BELOW the
 * boundary, so the anchor survives, the derived index just decrements, and
 * grouping stays on the cheap incremental path. null = no window (show all).
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { fetchTranscriptBefore, useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptEntry } from '@/lib/types'
import {
  defaultAnchorSeq,
  LOAD_CHUNK,
  WINDOW_REANCHOR_MARGIN,
  WINDOW_SIZE,
  WINDOW_THRESHOLD,
} from './transcript-window-core'
import { useTranscriptHeadHold } from './use-transcript-head-hold'

type Ref<T> = { current: T }

export interface TranscriptWindow {
  /** The entries to render (the windowed tail of `entries`). */
  windowed: TranscriptEntry[]
  windowStart: number
  windowStartRef: Ref<number>
  /** The window's top-boundary seq (null = show all). Stable across a
   *  head-prune; moves on switch/reveal -- callers use it to distinguish
   *  window movement from plain tail growth (e.g. enter-animation gating). */
  windowAnchorSeq: number | null
  /** Grouping reset signal: identity of the FIRST rendered entry. Changes on a
   *  local window reveal AND a server prepend -- both head-growth the tail-only
   *  incremental grouping path would mis-group. Stable during streaming and
   *  across a head-prune. */
  regroupSignal: number | string
  /** More history exists on the server iff our oldest-held entry isn't seq 1. */
  hasMoreOlder: boolean
  hasMoreOlderRef: Ref<boolean>
  entriesRef: Ref<TranscriptEntry[]>
  cacheKeyRef: Ref<string | undefined>
  /** Reveal a chunk of already-loaded older entries (moves the window anchor). */
  loadEarlier: () => void
  /** Fetch older entries from the broker (infinite scrollback). */
  fetchOlder: () => void
  loadingEarlierRef: Ref<boolean>
  fetchingOlderRef: Ref<boolean>
}

// Moved VERBATIM out of transcript-view.tsx -- the anchor/re-anchor branches ARE
// the documented incident fixes in the header; restructuring the state machine
// is a separate, device-verified change, not a gate-time refactor.
// fallow-ignore-next-line complexity
export function useTranscriptWindow(opts: {
  entries: TranscriptEntry[]
  cacheKey: string | undefined
  follow: boolean
  /** Called with the boundary entry's seq right before a reveal/fetch mutates
   *  the window -- the TanStack renderer registers a forced group break here
   *  (its item-granular prepend anchoring is blind to intra-group head growth).
   *  Also fired on a conversation switch with `undefined` so the caller can
   *  reset per-conversation state. */
  onBackfillBoundary?: (seq: number | undefined) => void
  /** Called synchronously IMMEDIATELY before the state/store mutation that
   *  inserts content above the viewport -- the plain renderer arms its
   *  scrollHeight-delta prepend anchor here. */
  onBeforePrepend?: () => void
}): TranscriptWindow {
  const { entries, cacheKey, follow } = opts
  const onBackfillBoundaryRef = useRef(opts.onBackfillBoundary)
  onBackfillBoundaryRef.current = opts.onBackfillBoundary
  const onBeforePrependRef = useRef(opts.onBeforePrepend)
  onBeforePrependRef.current = opts.onBeforePrepend

  const [windowAnchorSeq, setWindowAnchorSeq] = useState<number | null>(() => defaultAnchorSeq(entries))
  // Visit-scoped "user loaded older history" latch (see use-transcript-head-hold).
  const { headHeldRef, markHeadHeld } = useTranscriptHeadHold(cacheKey)
  const prevCacheKeyRef = useRef(cacheKey)
  // True once we've sized the window against a NON-EMPTY transcript for the
  // current cacheKey. A cold switch (MISS) opens with entries=[] (fetch in
  // flight); without this flag the window would never re-default when the
  // fetched transcript arrives and a fresh 460-entry conversation would render
  // ALL of it (measured 340ms commit->paint).
  const windowInitRef = useRef(entries.length > 0)
  // Derived slice index: the first entry at or after the anchor seq.
  const windowStart = useMemo(() => {
    if (windowAnchorSeq === null) return 0
    const idx = entries.findIndex(e => (e.seq ?? 0) >= windowAnchorSeq)
    return idx < 0 ? 0 : idx
  }, [entries, windowAnchorSeq])
  // Render-phase anchor setter with a CONVERGENCE GUARD (React #301): only fire
  // when the anchor actually changes, so a seqless transcript (defaultAnchorSeq
  // stuck at null/same value) cannot loop the render phase.
  const reanchorTo = (next: number | null) => {
    if (next !== windowAnchorSeq) setWindowAnchorSeq(next)
  }
  // Derived-state reset (the documented "adjust state on prop change in render"
  // pattern -- re-renders before commit, no flash):
  if (cacheKey !== prevCacheKeyRef.current) {
    // Conversation switch -- snap to the last-N default for whatever is loaded.
    prevCacheKeyRef.current = cacheKey
    windowInitRef.current = entries.length > 0
    headHeldRef.current = false
    onBackfillBoundaryRef.current?.(undefined)
    reanchorTo(defaultAnchorSeq(entries))
  } else if (!windowInitRef.current && entries.length > 0) {
    // Cold-open transcript just arrived (MISS -> fetch). Size the window now.
    windowInitRef.current = true
    reanchorTo(defaultAnchorSeq(entries))
  } else if (
    windowAnchorSeq !== null &&
    entries.length > 0 &&
    (entries[entries.length - 1].seq ?? 0) < windowAnchorSeq
  ) {
    // Anchor slid past the end of a shrunk/replaced array (e.g. /clear creating
    // a new transcript whose seqs are all below the old anchor). Re-default.
    reanchorTo(defaultAnchorSeq(entries))
  } else if (
    follow &&
    !headHeldRef.current &&
    entries.length > WINDOW_THRESHOLD &&
    (windowAnchorSeq === null || windowStart < WINDOW_REANCHOR_MARGIN)
  ) {
    // The window boundary is at (or has drifted near) the pruned head: either
    // tail-append + head-prune walked the anchor entry to the head, or a deep
    // scrollback set the anchor NULL ("show all") and the reader returned to
    // the bottom. Re-default forward so the boundary sits safely above the
    // prune line again. Gated on `follow` (viewport at the bottom) so dropping
    // the now-offscreen older entries is invisible -- a scrollback reader is
    // never yanked. ALSO gated on the head-hold: once the user loaded older
    // history this visit, snapping back to last-N would visibly collapse the
    // scrollbar (the "return to bottom kills my loaded history" bug). While
    // held, the store prune backs off too (lib/transcript-prune.ts), so the
    // head is stable and regroup thrash cannot occur.
    const reanchored = defaultAnchorSeq(entries)
    if (reanchored !== windowAnchorSeq) {
      console.debug(
        `[window] re-anchor reason=${windowAnchorSeq === null ? 'post-scrollback-show-all' : 'near-pruned-head'} entries=${entries.length} windowStart=${windowStart} -> last-${WINDOW_SIZE}`,
      )
      reanchorTo(reanchored)
    }
  }
  const windowed = useMemo(() => (windowStart > 0 ? entries.slice(windowStart) : entries), [entries, windowStart])
  // Live mirrors for stable callbacks/handlers that must read latest values.
  const windowStartRef = useRef(windowStart)
  windowStartRef.current = windowStart
  const regroupSignal = windowed.length > 0 ? (windowed[0].seq ?? windowed[0].uuid ?? windowStart) : windowStart
  const hasMoreOlder = (entries[0]?.seq ?? 1) > 1
  const hasMoreOlderRef = useRef(hasMoreOlder)
  hasMoreOlderRef.current = hasMoreOlder
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const cacheKeyRef = useRef(cacheKey)
  cacheKeyRef.current = cacheKey

  // Re-entrancy guards (shared with the caller's trigger machinery).
  const loadingEarlierRef = useRef(false)
  const fetchingOlderRef = useRef(false)

  const loadEarlier = useCallback(() => {
    const ents = entriesRef.current
    markHeadHeld()
    // The current top-visible entry becomes a backfill boundary.
    onBackfillBoundaryRef.current?.(ents[windowStartRef.current]?.seq)
    onBeforePrependRef.current?.()
    const newStart = Math.max(0, windowStartRef.current - LOAD_CHUNK)
    // Move the anchor to the newly-revealed boundary entry (null = reached the
    // top, show all). Derived windowStart re-resolves on the next render.
    setWindowAnchorSeq(newStart <= 0 ? null : (ents[newStart]?.seq ?? null))
  }, [markHeadHeld])

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
  }, [markHeadHeld])

  return {
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
  }
}
