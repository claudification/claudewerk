/**
 * The shape `useTranscriptWindow` hands its two renderers.
 *
 * Its own file so the hook stays the state machine and nothing else -- the
 * interface is almost entirely prose, and every field on it documents an
 * invariant a renderer can break (the seq anchor surviving a head-prune, the
 * regroup signal firing on head growth, reveal never moving the boundary
 * forward). See use-transcript-window.ts for why each one exists.
 */

import type { TranscriptEntry } from '@/lib/types'

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
  /** Widen the window DOWNWARD to a specific seq -- the transcript-search jump.
   *  Unlike loadEarlier (which walks back a fixed chunk) this moves the boundary
   *  to a named entry in one step, and never moves it forward: a target already
   *  inside the window needs no reveal at all. */
  revealSeq: (seq: number) => void
  /** Fetch older entries from the broker (infinite scrollback). */
  fetchOlder: () => void
  loadingEarlierRef: Ref<boolean>
  fetchingOlderRef: Ref<boolean>
}
