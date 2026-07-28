import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  it('scales up with chunk count and ceils at 20min', () => {
    // Ceil dropped 45min -> 20min: the overall conv-scaled deadline (deadline.ts)
    // is now the master cap for the whole render, so the map stage sits under it.
    // At MAP_CONCURRENCY=8 (raised from 4 on 2026-07-27) 10 chunks are 2 waves,
    // which prices under the floor -- the floor is what they get.
    expect(mapStageDeadlineMs(10)).toBe(10 * 60_000) // floor
    expect(mapStageDeadlineMs(20)).toBeGreaterThan(10 * 60_000) // 3 waves clears it
    expect(mapStageDeadlineMs(20)).toBeLessThan(20 * 60_000)
    expect(mapStageDeadlineMs(1000)).toBe(20 * 60_000) // ceil
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

  it('labels a truncated (over-cap) map output as truncation, not a generic parse error', async () => {
    // finish_reason=length -> a huge unparseable blob. Normal output is <20k chars.
    const truncated = `{"keywords":["${'x'.repeat(60_000)}` // no closing -> unparseable + >50k chars
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: truncated } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
    const warns: string[] = []
    const emit: ProgressEmitter = {
      emit: (level, _phase, message) => {
        if (level === 'warn') warns.push(message)
      },
      setProgress: () => {},
      setStatus: () => {},
    }
    const result = await runMapStage(makeDeps(), 'recap_t', new RecapLedger(), emit, [chunk(0, 'BIG')], 'm', {})
    expect(result.failed).toBe(1)
    expect(warns.some(w => w.includes('truncated at the token cap'))).toBe(true)
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

// The cross-run map cache stores a chunk's extraction so tomorrow's run does not
// re-pay for it. A FAILED chunk still yields empty metadata (so the run can go
// on), and filing THAT would pin the conversation to "no facts" for the life of
// the entry -- silently gutting every future recap that touches it. `trusted` is
// the guard, so it has to be exactly the chunks that really parsed.
describe('runMapStage trusted set (what is safe to cache)', () => {
  it('trusts only chunks whose extraction actually parsed', async () => {
    process.env.CLAUDWERK_RECAP_MAP_TIMEOUT_MS = '40'
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('HANG')) return new Promise<Response>(() => {}) // -> failed
      if (body.includes('JUNK')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"keywords":["k"]}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const chunks = [chunk(0, null), chunk(1, 'GOOD'), chunk(2, 'HANG'), chunk(3, 'JUNK')]
    const result = await runMapStage(
      makeDeps(),
      'recap_test',
      new RecapLedger(),
      noopEmit,
      chunks,
      'anthropic/claude-sonnet-4',
      {},
    )

    expect([...result.trusted]).toEqual([1]) // ONLY the chunk that parsed
    expect(result.trusted.has(0)).toBe(false) // empty/skipped -- no evidence either way
    expect(result.trusted.has(2)).toBe(false) // timed out
    expect(result.trusted.has(3)).toBe(false) // unparseable
  })
})

describe('runMapStage -- salvage + repair wiring', () => {
  const INCIDENT = readFileSync(join(import.meta.dir, 'chunk', '__fixtures__', 'malformed-map-dead-ends.txt'), 'utf8')

  function respondOnce(bodies: string[]) {
    globalThis.fetch = (async () => {
      const content = bodies.shift() ?? '{"keywords":[]}'
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
  }

  it('repairs a malformed chunk and trusts the result', async () => {
    respondOnce([INCIDENT, '{"keywords":["k"]}'])
    const result = await runMapStage(makeDeps(), 'recap_r', new RecapLedger(), noopEmit, [chunk(0, 'BIG')], 'm', {})
    expect(result.failed).toBe(0)
    expect(result.salvaged).toBe(0)
    expect(result.trusted.has(0)).toBe(true)
    expect(result.failures).toHaveLength(0)
  })

  it('a salvaged chunk is NOT trusted -- it must never be cached or banked', async () => {
    respondOnce([INCIDENT, 'still not json'])
    const result = await runMapStage(makeDeps(), 'recap_s', new RecapLedger(), noopEmit, [chunk(0, 'BIG')], 'm', {})
    expect(result.salvaged).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.trusted.has(0)).toBe(false)
    expect(result.metas[0].goals).toHaveLength(3) // the data still made it into the run
    expect(result.failures[0]?.outcome).toBe('salvaged')
  })

  it('names the conversations behind every casualty', async () => {
    respondOnce(['not json at all', 'still not'])
    const result = await runMapStage(makeDeps(), 'recap_n', new RecapLedger(), noopEmit, [chunk(0, 'BIG')], 'm', {})
    expect(result.failed).toBe(1)
    expect(result.failures[0]?.conversations.length).toBeGreaterThan(0)
    expect(result.failures[0]?.conversations[0]?.id).toBeTruthy()
  })
})
