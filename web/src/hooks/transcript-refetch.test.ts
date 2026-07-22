/**
 * THE BROKER-RESTART SCREENSHOT (2026-07-23).
 *
 * Jonas restarts the broker; every panel reconnects, `sync_check` reports the
 * transcript stale, and the delta refetch pulls the gap. What rendered was a
 * span of OLDER entries -- Stop 23:28:43, user 23:29:20, Stop 23:45:22, error
 * 23:58:44 -- sitting BELOW entries stamped 23:58:48 and 23:59:06, and then the
 * whole span repeated. Switching conversation away and back repaired it, which
 * is the tell that the store was clean and only the in-memory array was wrong.
 *
 * Cause: this path merged with `[...existing, ...fresh]` behind a seq-only
 * floor. `0f5892b7` fixed exactly that on the live WS broadcast path and never
 * touched the refetch, so the old behaviour survived here.
 *
 * Both defects need the same two properties, so both are pinned below:
 *   ORDER    -- a late gap-fill renders where it happened, not at the tail.
 *   IDENTITY -- dedup is by uuid, because seq is an arrival counter and a resend
 *               can hand back an entry we already hold under a fresh one.
 *
 * The uuid rule is defence in depth, NOT a patch for a known storage bug. An
 * earlier draft of this comment claimed the broker persists two rows for one
 * logical user entry when the content is an array (a timestamp-derived uuid on
 * the live echo vs CC's own on the file resend). That was a hypothesis, and the
 * production store refuses it: grouping array-content user rows by conversation
 * + timestamp + content finds NO group carrying more than one uuid. Rows that
 * share a timestamp are parallel tool_results, each genuinely distinct. Treat
 * the claim as dead unless a real repro turns up.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptEntry } from '@/lib/types'

const fetchTranscript = vi.fn()

vi.mock('./use-conversations', async () => {
  const { create } = await import('zustand')
  const useConversationsStore = create(() => ({
    transcripts: {} as Record<string, TranscriptEntry[]>,
    lastAppliedTranscriptSeq: {} as Record<string, number>,
    scrollbackActive: {} as Record<string, boolean>,
    transcriptHeadHeld: {} as Record<string, boolean>,
    newDataSeq: 0,
    setTranscript: (sid: string, entries: TranscriptEntry[]) =>
      useConversationsStore.setState(s => ({ transcripts: { ...s.transcripts, [sid]: entries } })),
  }))
  return { useConversationsStore, fetchTranscript }
})

const { refetchStaleTranscripts } = await import('./transcript-refetch')
const { useConversationsStore } = await import('./use-conversations')

const SID = 'conv-restart-0001'

/** `clock` is a literal wall time -- the screenshot's own, so the fixtures read
 *  as the timestamps in it rather than as offsets you have to do arithmetic on. */
const at = (uuid: string, clock: string, seq: number, type = 'assistant'): TranscriptEntry => {
  const [h, m, s] = clock.split(':').map(Number)
  return {
    type,
    uuid,
    seq,
    timestamp: new Date(Date.UTC(2026, 6, 22, h, m, s)).toISOString(),
  } as unknown as TranscriptEntry
}

const ids = (): string[] => (useConversationsStore.getState().transcripts[SID] ?? []).map(e => e.uuid as string)

function seed(entries: TranscriptEntry[], localSeq: number) {
  useConversationsStore.setState({
    transcripts: { [SID]: entries },
    lastAppliedTranscriptSeq: { [SID]: localSeq },
    scrollbackActive: {},
    transcriptHeadHeld: {},
  })
}

/** Drain the refetch's promise chain -- one `await fetchTranscript` deep. */
const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  fetchTranscript.mockReset()
})

describe('refetchStaleTranscripts', () => {
  it('places a late gap-fill by timestamp instead of concatenating it at the tail', async () => {
    // We hold the live tail. The refetch brings the file-recovered entries that
    // stdout dropped: old timestamps, brand new high seqs.
    seed([at('t2358_48', '23:58:48', 40), at('t2359_06', '23:59:06', 41)], 41)
    fetchTranscript.mockResolvedValue({
      entries: [
        at('stop_2328', '23:28:43', 42),
        at('user_2329', '23:29:20', 43, 'user'),
        at('stop_2345', '23:45:22', 44),
        at('err_2358', '23:58:44', 45),
      ],
      lastSeq: 45,
    })

    refetchStaleTranscripts({ [SID]: 45 })
    await settle()

    // Chronological, not arrival. The screenshot rendered the whole 23:28-23:58
    // span BELOW the 23:58:48 / 23:59:06 pair it predates.
    expect(ids()).toEqual(['stop_2328', 'user_2329', 'stop_2345', 'err_2358', 't2358_48', 't2359_06'])
  })

  it('does not re-append an entry we already hold when it comes back with a fresh seq', async () => {
    // The broker-restart resend: same uuid, higher seq, so a seq-only floor
    // waves it through and the span renders twice.
    seed([at('user_2329', '23:29:20', 10, 'user'), at('err_2358', '23:58:44', 11)], 11)
    fetchTranscript.mockResolvedValue({
      entries: [
        at('user_2329', '23:29:20', 12, 'user'),
        at('err_2358', '23:58:44', 13),
        at('fresh', '23:59:30', 14),
      ],
      lastSeq: 14,
    })

    refetchStaleTranscripts({ [SID]: 14 })
    await settle()

    expect(ids()).toEqual(['user_2329', 'err_2358', 'fresh'])
  })

  it('still applies a genuinely new tail entry', async () => {
    seed([at('a', '23:10:00', 1)], 1)
    fetchTranscript.mockResolvedValue({ entries: [at('b', '23:20:00', 2)], lastSeq: 2 })

    refetchStaleTranscripts({ [SID]: 2 })
    await settle()

    expect(ids()).toEqual(['a', 'b'])
    expect(useConversationsStore.getState().lastAppliedTranscriptSeq[SID]).toBe(2)
  })

  it('skips the fetch entirely when the server seq is not ahead of ours', async () => {
    seed([at('a', '23:10:00', 5)], 5)

    refetchStaleTranscripts({ [SID]: 5 })
    await settle()

    expect(fetchTranscript).not.toHaveBeenCalled()
  })

  it('replaces wholesale when the server reports a gap it cannot fill', async () => {
    seed([at('stale', '23:10:00', 1)], 1)
    fetchTranscript.mockResolvedValue({ entries: [at('x', '23:50:00', 90), at('y', '23:51:00', 91)], lastSeq: 91, gap: true })

    refetchStaleTranscripts({ [SID]: 91 })
    await settle()

    expect(ids()).toEqual(['x', 'y'])
  })
})
