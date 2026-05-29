import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTranscript } from './use-conversations'

/**
 * Phase C defense-in-depth: the cold-open parent transcript fetch asks the
 * broker for `filter=display` so leaked noise rows (task_progress /
 * task_notification -- the conv 52b5f3ec empty-render chatter) are dropped
 * before they reach the client. Delta refetches stay unfiltered so sync
 * recovery never perceives a seq gap.
 */
describe('fetchTranscript -- filter=display defense-in-depth', () => {
  afterEach(() => vi.restoreAllMocks())

  function mockFetchOnce(body: unknown) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
  }

  it('requests filter=display on cold open (no sinceSeq)', async () => {
    const spy = mockFetchOnce({ entries: [], lastSeq: 0, gap: false })
    await fetchTranscript('conv_x')
    const url = String(spy.mock.calls[0]?.[0])
    expect(url).toContain('filter=display')
    expect(url).toContain('limit=')
  })

  it('does NOT filter on a delta refetch (sinceSeq set)', async () => {
    const spy = mockFetchOnce({ entries: [], lastSeq: 5, gap: false })
    await fetchTranscript('conv_x', 5)
    const url = String(spy.mock.calls[0]?.[0])
    expect(url).toContain('sinceSeq=5')
    expect(url).not.toContain('filter=display')
  })
})
