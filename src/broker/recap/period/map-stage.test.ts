import { afterEach, describe, expect, it } from 'bun:test'
import type { TranscriptChunk } from './chunk/split'
import { RecapLedger } from './ledger'
import { mapStageDeadlineMs, type OrchestratorDeps, runMapStage } from './orchestrator'
import type { ProgressEmitter } from './progress'

const noopEmit: ProgressEmitter = { emit: () => {}, setProgress: () => {}, setStatus: () => {} }

// A chunk with a routable marker in its transcript (the marker lands in the map
// prompt body, so the mock fetch can tell chunks apart). marker=null -> empty.
function chunk(index: number, marker: string | null): TranscriptChunk {
  if (marker === null) return { index, transcripts: [], chars: 0, partialConversationIds: [] }
  return {
    index,
    transcripts: [
      {
        conversationId: `conv_${marker.toLowerCase()}`,
        conversationTitle: marker,
        turns: [{ turnIndex: 0, userPrompt: `${marker} did some work`, assistantFinal: 'done', timestamp: 1 }],
      },
    ],
    chars: 100,
    partialConversationIds: [],
  }
}

function makeDeps(): OrchestratorDeps {
  return {
    store: { update: () => {} },
    brokerStore: {},
    broadcaster: { broadcast: () => {} },
    apiKey: 'test-key',
  } as unknown as OrchestratorDeps
}

const ORIGINAL_FETCH = globalThis.fetch
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  delete process.env.CLAUDWERK_RECAP_MAP_TIMEOUT_MS
  delete process.env.CLAUDWERK_RECAP_MAP_STAGE_DEADLINE_MS
})

describe('mapStageDeadlineMs (conv-count scaled)', () => {
  it('floors at 10min for small recaps', () => {
    expect(mapStageDeadlineMs(1)).toBe(10 * 60_000)
    expect(mapStageDeadlineMs(6)).toBe(10 * 60_000) // 2 waves -> 9.6min -> floored
  })
  it('scales up with chunk count and ceils at 45min', () => {
    expect(mapStageDeadlineMs(30)).toBeGreaterThan(10 * 60_000)
    expect(mapStageDeadlineMs(30)).toBeLessThan(45 * 60_000)
    expect(mapStageDeadlineMs(1000)).toBe(45 * 60_000) // ceil
  })
  it('honours the env override (test/ops seam)', () => {
    process.env.CLAUDWERK_RECAP_MAP_STAGE_DEADLINE_MS = '123'
    expect(mapStageDeadlineMs(6)).toBe(123)
  })
})

describe('runMapStage', () => {
  it('skips empty chunks (G8), degrades a hung chunk, parses a good one -- never hangs the barrier', async () => {
    // Tight per-call timeout so the hung chunk fails fast instead of waiting 120s.
    process.env.CLAUDWERK_RECAP_MAP_TIMEOUT_MS = '40'
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('HANG')) return new Promise<Response>(() => {}) // never settles -> per-call timeout
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"keywords":["k"],"features":[]}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const chunks = [chunk(0, null), chunk(1, 'GOOD'), chunk(2, 'HANG')]
    const result = await runMapStage(
      makeDeps(),
      'recap_test',
      new RecapLedger(),
      noopEmit,
      chunks,
      'anthropic/claude-sonnet-4',
      {},
    )

    expect(result.metas).toHaveLength(3) // every chunk yields a meta (empty or parsed)
    expect(result.skippedEmpty).toBe(1) // chunk 0 -- G8, no LLM call
    expect(result.failed).toBe(1) // chunk 2 -- hung, degraded (NOT a hang)
    expect(result.metas[1].keywords).toEqual(['k']) // chunk 1 -- the good one parsed
  })

  it('does not count empty chunks as failures', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"keywords":[],"features":[]}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
    const chunks = [chunk(0, null), chunk(1, null), chunk(2, 'GOOD')]
    const result = await runMapStage(
      makeDeps(),
      'recap_test',
      new RecapLedger(),
      noopEmit,
      chunks,
      'anthropic/claude-sonnet-4',
      {},
    )
    expect(result.skippedEmpty).toBe(2)
    expect(result.failed).toBe(0)
  })
})
