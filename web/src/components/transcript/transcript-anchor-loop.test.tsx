/**
 * Regression test for the SEQLESS-transcript render loop (React #301,
 * "too many re-renders") in TranscriptView.
 *
 * ROOT CAUSE: the progressive-window anchor is a SEQ (`windowAnchorSeq`), derived
 * during render from the entries. `seq` is OPTIONAL on a TranscriptEntry --
 * undefined on entries read from raw JSONL before the broker's cache-insert
 * stamps it (protocol.ts), and the control panel does receive such entries
 * (use-websocket-handlers dedupes on `e.seq === undefined`). When the window
 * BOUNDARY entry (entries[len - WINDOW_SIZE]) had no seq, defaultAnchorSeq
 * returned null. The re-anchor branch fires while `follow` is on, the transcript
 * is past the window threshold, and `windowAnchorSeq === null`: it called
 * setWindowAnchorSeq(null), which left the anchor null, so the same branch
 * re-fired on the next render-phase pass -- forever -- until React threw #301.
 *
 * FIX (two parts):
 *  1. defaultAnchorSeq scans FORWARD from the ideal boundary for the nearest
 *     entry that carries a seq (never widening past WINDOW_SIZE), so a window
 *     still anchors when only SOME entries are seqless; returns null only when
 *     no entry from the boundary onward has a seq.
 *  2. A render-phase convergence guard (reanchorTo) only calls the setter when
 *     the anchor actually changes -- so even the all-seqless case (target stays
 *     null) cannot re-arm React's render-phase update.
 *
 * The render-level assertion is just "mounting does not throw": with the bug,
 * render() throws #301 synchronously; with the fix it renders cleanly.
 */

import { cleanup, render } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { TranscriptEntry } from '@/lib/types'
import { TranscriptView } from './transcript-view'
import { defaultAnchorSeq } from './transcript-window-core'

// A minimal user entry. `seq` is attached only when provided -- omitting it
// reproduces the raw-JSONL (pre-ingest) shape that triggered the loop.
function entry(i: number, seq?: number): TranscriptEntry {
  return {
    type: 'user',
    uuid: `u-${i}`,
    timestamp: '2026-06-23T11:00:00.000Z',
    message: { role: 'user', content: `msg ${i}` },
    ...(seq !== undefined && { seq }),
  } as unknown as TranscriptEntry
}

// > WINDOW_THRESHOLD (80) so the progressive window engages and the re-anchor
// branch is reachable.
function seqlessTranscript(n = 100): TranscriptEntry[] {
  return Array.from({ length: n }, (_, i) => entry(i))
}

// jsdom has no ResizeObserver; the virtualizer's observeElementRect constructs
// one. A no-op stub is enough -- the reset loop under test runs at the top of the
// component body, BEFORE the virtualizer is created, so this only keeps the rest
// of the render alive.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub

afterEach(cleanup)
beforeEach(() => {
  act(() => {
    useConversationsStore.setState({
      selectedConversationId: null,
      conversationsById: {},
      streamingText: {},
      streamingThinking: {},
      transcriptRemeasureSeq: 0,
      controlPanelPrefs: { showPerfMonitor: false, scrollbackReservation: false },
    } as never)
  })
})

describe('defaultAnchorSeq -- seqless resilience', () => {
  it('returns null when the transcript is shorter than the window', () => {
    expect(defaultAnchorSeq(Array.from({ length: 10 }, (_, i) => entry(i, i + 1)))).toBeNull()
  })

  it('anchors on the boundary entry seq when it has one', () => {
    // len 100 -> boundary index 50 -> that entry's seq.
    const entries = Array.from({ length: 100 }, (_, i) => entry(i, i + 1))
    expect(defaultAnchorSeq(entries)).toBe(51)
  })

  it('scans FORWARD past a seqless boundary to the nearest seq (window stays anchored)', () => {
    // Boundary (idx 50) and the next few entries are seqless; seqs resume at idx 60.
    const entries = Array.from({ length: 100 }, (_, i) => entry(i, i >= 60 ? i + 1 : undefined))
    // First defined seq at/after idx 50 is at idx 60 -> value 61. NOT null.
    expect(defaultAnchorSeq(entries)).toBe(61)
  })

  it('returns null only when NO entry from the boundary onward has a seq', () => {
    expect(defaultAnchorSeq(seqlessTranscript(100))).toBeNull()
  })
})

describe('defaultAnchorSeq -- budgets by DISPLAYABLE entries, not raw', () => {
  // A status heartbeat: persisted but never rendered. Every tool call also emits
  // a tool_result user entry that renders inside its tool_use line. Both must NOT
  // consume the window's ~50-item budget.
  const statusEntry = (seq: number): TranscriptEntry =>
    ({ type: 'system', subtype: 'status', seq, timestamp: '2026-07-21T00:00:00.000Z' }) as unknown as TranscriptEntry

  it('walks past interleaved status noise so ~WINDOW_SIZE real items are covered', () => {
    // 200 entries, seq i+1: even idx = real user text (displayable), odd = status.
    // 100 displayable total. Walking back for 50 displayable lands on idx 100
    // (seq 101) -- NOT the raw len-50 boundary (idx 150 / seq 151).
    const entries = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? entry(i, i + 1) : statusEntry(i + 1)))
    expect(defaultAnchorSeq(entries)).toBe(101)
  })

  it('caps the backward scan at WINDOW_MAX_RAW when the tail is nearly all noise', () => {
    // 400 entries, only the last (idx 399) is displayable. The walk cannot find
    // 50 displayable, so it stops at the raw floor len-300 (idx 100, seq 101)
    // rather than dragging the whole conversation into the first render.
    const entries = Array.from({ length: 400 }, (_, i) => (i === 399 ? entry(i, i + 1) : statusEntry(i + 1)))
    expect(defaultAnchorSeq(entries)).toBe(101)
  })
})

describe('TranscriptView -- seqless render loop', () => {
  it('does NOT throw React #301 on a fully-seqless transcript with follow on', () => {
    expect(() =>
      render(
        <TranscriptView conversationId="c1" entries={seqlessTranscript(100)} follow showThinking cacheKey="conv_seqless" />,
      ),
    ).not.toThrow()
  })

  it('does NOT throw on a partially-seqless transcript (boundary seqless, tail seq) with follow on', () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(i, i >= 60 ? i + 1 : undefined))
    expect(() =>
      render(<TranscriptView conversationId="c1" entries={entries} follow cacheKey="conv_partial" />),
    ).not.toThrow()
  })
})
