import { describe, expect, test } from 'bun:test'
import type { ForkPoint, TranscriptEntry } from '../shared/protocol'
import {
  DROPPED_SUMMARY_MIN_ENTRIES,
  DROPPED_SUMMARY_MODEL,
  summarizeDroppedSlice,
} from './fork-dropped-summary'
import type { chat } from './recap/shared/openrouter-client'

/** A user/assistant pair per index, one minute apart, uuids e0..e(n-1). */
function entries(n: number): TranscriptEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const min = String(i).padStart(2, '0')
    const role = i % 2 === 0 ? 'user' : 'assistant'
    return {
      type: role,
      uuid: `e${i}`,
      timestamp: `2026-08-19T10:${min}:00.000Z`,
      message:
        role === 'user'
          ? { role: 'user', content: `prompt ${i}` }
          : { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] },
    } as unknown as TranscriptEntry
  })
}

function stubChat(capture?: { req?: Parameters<typeof chat>[0]; body?: string }) {
  return (async (req: Parameters<typeof chat>[0]) => {
    if (capture) {
      capture.req = req
      capture.body = req.user
    }
    return { content: 'They renamed the slug helper and verified it.' } as Awaited<ReturnType<typeof chat>>
  }) as typeof chat
}

const point = (over: Partial<ForkPoint> = {}): ForkPoint => ({
  uuid: 'e20',
  direction: 'after',
  inclusive: true,
  summarizeDropped: true,
  ...over,
})

describe('summarizeDroppedSlice -- when it declines', () => {
  test('does nothing when the checkbox is off', async () => {
    const r = await summarizeDroppedSlice({
      entries: entries(30),
      forkPoint: point({ summarizeDropped: false }),
      chatFn: stubChat(),
    })
    expect(r).toBeUndefined()
  })

  test('does nothing for carry-BEFORE -- the dropped slice is the future being redone', async () => {
    const r = await summarizeDroppedSlice({
      entries: entries(30),
      forkPoint: point({ direction: 'before' }),
      chatFn: stubChat(),
    })
    expect(r).toBeUndefined()
  })

  test('does nothing when the boundary does not resolve', async () => {
    const r = await summarizeDroppedSlice({
      entries: entries(30),
      forkPoint: point({ uuid: 'nope', timestamp: undefined }),
      chatFn: stubChat(),
    })
    expect(r).toBeUndefined()
  })

  test('does nothing when too little would be dropped to be worth a model call', async () => {
    // Cutting at e2 drops only e0..e1 -- under the floor.
    const r = await summarizeDroppedSlice({
      entries: entries(30),
      forkPoint: point({ uuid: 'e2' }),
      chatFn: stubChat(),
    })
    expect(r).toBeUndefined()
    expect(DROPPED_SUMMARY_MIN_ENTRIES).toBeGreaterThan(2)
  })

  test('a model failure degrades the preamble instead of failing the fork', async () => {
    const r = await summarizeDroppedSlice({
      entries: entries(30),
      forkPoint: point(),
      chatFn: (async () => {
        throw new Error('openrouter 503')
      }) as typeof chat,
    })
    expect(r).toBeUndefined()
  })

  test('an empty response yields no preamble rather than an empty label', async () => {
    const r = await summarizeDroppedSlice({
      entries: entries(30),
      forkPoint: point(),
      chatFn: (async () => ({ content: '   ' })) as unknown as typeof chat,
    })
    expect(r).toBeUndefined()
  })
})

describe('summarizeDroppedSlice -- when it summarizes', () => {
  test('labels the block as summarized and counts the dropped turns', async () => {
    const r = await summarizeDroppedSlice({ entries: entries(30), forkPoint: point(), chatFn: stubChat() })
    expect(r).toContain('earlier context')
    expect(r).toContain('20 turns')
    expect(r).toContain('renamed the slug helper')
  })

  test('feeds the model ONLY the dropped slice, never the kept tail', async () => {
    const cap: { body?: string } = {}
    await summarizeDroppedSlice({ entries: entries(30), forkPoint: point(), chatFn: stubChat(cap) })
    expect(cap.body).toContain('prompt 0')
    expect(cap.body).toContain('answer 19')
    // e20 onward is kept verbatim -- summarizing it too would duplicate it.
    expect(cap.body).not.toContain('prompt 20')
    expect(cap.body).not.toContain('answer 29')
  })

  test('uses the fast model and tags the spend', async () => {
    const cap: { req?: Parameters<typeof chat>[0] } = {}
    await summarizeDroppedSlice({ entries: entries(30), forkPoint: point(), chatFn: stubChat(cap) })
    expect(cap.req?.model).toBe(DROPPED_SUMMARY_MODEL)
    expect(cap.req?.feature).toBe('fork-dropped-summary')
  })

  test('resolves the boundary by timestamp when the uuid is panel-only', async () => {
    const cap: { body?: string } = {}
    const r = await summarizeDroppedSlice({
      entries: entries(30),
      // A voice prompt's uuid never reaches the file; the timestamp still does.
      forkPoint: point({ uuid: 'panel-only', timestamp: '2026-08-19T10:20:30.000Z' }),
      chatFn: stubChat(cap),
    })
    expect(r).toContain('20 turns')
    expect(cap.body).not.toContain('prompt 20')
  })
})
