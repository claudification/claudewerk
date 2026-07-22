/**
 * The visit-scoped history hold ("return to bottom must NOT kill loaded
 * scrollback"). Covers the shared prune policy (lib/transcript-prune.ts) and
 * the store actions that ride it (holdTranscriptHead / releaseTranscriptHead /
 * setScrollbackActive collapse gating). Prior art the policy encodes:
 * ChatGPT/Slack/Discord keep loaded history for the whole visit and only
 * drop it on an explicit conversation switch.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { HELD_PRUNE_CHUNK, pruneLiveTranscript, TRANSCRIPT_HELD_CAP, TRANSCRIPT_LIVE_CAP } from '@/lib/transcript-prune'
import type { TranscriptEntry } from '@/lib/types'

const prune = pruneLiveTranscript

function entries(n: number, startSeq = 1): TranscriptEntry[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        type: 'user',
        uuid: `u-${startSeq + i}`,
        seq: startSeq + i,
        timestamp: '2026-07-21T11:00:00.000Z',
        message: { role: 'user', content: `msg ${startSeq + i}` },
      }) as unknown as TranscriptEntry,
  )
}

describe('pruneLiveTranscript policy', () => {
  it('returns the same array when under the cap', () => {
    const arr = entries(50)
    expect(prune({ sid: 'c1', entries: arr, scrollback: false, held: false, source: 't' })).toBe(arr)
  })

  it('prunes an unheld transcript to the live cap', () => {
    const arr = entries(150)
    const kept = prune({ sid: 'c1', entries: arr, scrollback: false, held: false, source: 't' })
    expect(kept.length).toBe(TRANSCRIPT_LIVE_CAP)
    expect(kept[0].seq).toBe(51)
  })

  it('never prunes while scrollback is active (reader detached)', () => {
    const arr = entries(300)
    expect(prune({ sid: 'c1', entries: arr, scrollback: true, held: false, source: 't' })).toBe(arr)
  })

  it('held: keeps everything under the held cap', () => {
    const arr = entries(600)
    expect(prune({ sid: 'c1', entries: arr, scrollback: false, held: true, source: 't' })).toBe(arr)
  })

  it('held: over the held cap drops a hysteresis chunk, not per-entry', () => {
    const arr = entries(TRANSCRIPT_HELD_CAP + 1)
    const kept = prune({ sid: 'c1', entries: arr, scrollback: false, held: true, source: 't' })
    expect(kept.length).toBe(TRANSCRIPT_HELD_CAP - HELD_PRUNE_CHUNK)
    // Next append is HELD_PRUNE_CHUNK away from the cap -- no per-tick thrash.
    expect(pruneLiveTranscript({ sid: 'c1', entries: kept, scrollback: false, held: true, source: 't' })).toBe(kept)
  })
})

describe('store: hold / release / return-to-bottom collapse', () => {
  const SID = 'conv-hold-test'

  beforeEach(() => {
    useConversationsStore.setState({
      transcripts: { [SID]: entries(300) },
      scrollbackActive: { [SID]: true },
      transcriptHeadHeld: {},
    })
  })

  it('WITHOUT hold: return-to-bottom collapses to the live cap (legacy path)', () => {
    useConversationsStore.getState().setScrollbackActive(SID, false)
    expect(useConversationsStore.getState().transcripts[SID].length).toBe(TRANSCRIPT_LIVE_CAP)
  })

  it('WITH hold: return-to-bottom keeps every loaded entry', () => {
    useConversationsStore.getState().holdTranscriptHead(SID)
    useConversationsStore.getState().setScrollbackActive(SID, false)
    expect(useConversationsStore.getState().transcripts[SID].length).toBe(300)
    expect(useConversationsStore.getState().transcriptHeadHeld[SID]).toBe(true)
  })

  // The real switch-away path (use-transcript-head-hold.ts cleanup) calls ONLY
  // releaseTranscriptHead -- it does NOT manually reset scrollbackActive. So
  // releaseTranscriptHead itself must clear the scrollback latch, or a
  // background conversation's live tail defers pruning forever (unbounded
  // memory leak: the 93ea8702 climb `live=101 -> 132 ...` in the perf log).

  it('release (switch-away, head held) collapses AND clears the scrollback latch', () => {
    useConversationsStore.getState().holdTranscriptHead(SID)
    // scrollbackActive is left true (beforeEach) -- user scrolled up and never
    // returned to the bottom before clicking away. Only release fires:
    useConversationsStore.getState().releaseTranscriptHead(SID)
    const state = useConversationsStore.getState()
    expect(state.transcripts[SID].length).toBe(TRANSCRIPT_LIVE_CAP)
    expect(state.transcriptHeadHeld[SID]).toBeUndefined()
    expect(state.scrollbackActive[SID]).toBeFalsy()
  })

  it('release (switch-away, never held) still clears the scrollback latch and collapses', () => {
    // Scrolled up but never loaded older history -> no head hold. Old code
    // early-returned here and left scrollbackActive=true forever.
    useConversationsStore.getState().releaseTranscriptHead(SID)
    const state = useConversationsStore.getState()
    expect(state.scrollbackActive[SID]).toBeFalsy()
    expect(state.transcripts[SID].length).toBe(TRANSCRIPT_LIVE_CAP)
  })

  it('after release, a ws-broadcast prune resumes (no longer deferred)', () => {
    useConversationsStore.getState().releaseTranscriptHead(SID)
    const sb = !!useConversationsStore.getState().scrollbackActive[SID]
    // This is exactly what the ws-broadcast prune site reads for `scrollback`.
    const grown = entries(150)
    const kept = pruneLiveTranscript({ sid: SID, entries: grown, scrollback: sb, held: false, source: 'ws-broadcast' })
    expect(kept.length).toBe(TRANSCRIPT_LIVE_CAP)
  })

  it('release with no latches set is a no-op', () => {
    useConversationsStore.setState({
      transcripts: { [SID]: entries(50) },
      scrollbackActive: {},
      transcriptHeadHeld: {},
    })
    const before = useConversationsStore.getState().transcripts[SID]
    useConversationsStore.getState().releaseTranscriptHead(SID)
    expect(useConversationsStore.getState().transcripts[SID]).toBe(before)
  })
})
