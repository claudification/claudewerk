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

  it('release (conversation switch) collapses to the live cap and clears the hold', () => {
    useConversationsStore.getState().holdTranscriptHead(SID)
    useConversationsStore.getState().setScrollbackActive(SID, false)
    useConversationsStore.getState().releaseTranscriptHead(SID)
    const state = useConversationsStore.getState()
    expect(state.transcripts[SID].length).toBe(TRANSCRIPT_LIVE_CAP)
    expect(state.transcriptHeadHeld[SID]).toBeUndefined()
  })

  it('release without a hold is a no-op', () => {
    const before = useConversationsStore.getState().transcripts[SID]
    useConversationsStore.getState().releaseTranscriptHead(SID)
    expect(useConversationsStore.getState().transcripts[SID]).toBe(before)
  })
})
