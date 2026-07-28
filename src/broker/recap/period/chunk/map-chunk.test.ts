import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatRequest } from '../../shared/openrouter-client'
import { type MapChunkRunner, runMapChunk } from './map-chunk'
import type { TranscriptChunk } from './split'

const INCIDENT = readFileSync(join(import.meta.dir, '__fixtures__', 'malformed-map-dead-ends.txt'), 'utf8')

const GOOD = JSON.stringify({
  keywords: ['k'],
  goals: ['g'],
  bugs: [{ title: 'a bug' }],
})

function chunk(index = 148): TranscriptChunk {
  return {
    index,
    chars: 12_000,
    partialConversationIds: [],
    transcripts: [{ conversationId: '488cbece-b42', conversationTitle: 'AWS SES production access', turns: [] }],
  }
}

interface Recorded {
  stage: string
  req: ChatRequest
}

function runner(responses: string[], overrides: Partial<MapChunkRunner> = {}) {
  const calls: Recorded[] = []
  const logs: string[] = []
  const base: MapChunkRunner = {
    call: async (stage, req) => {
      calls.push({ stage, req })
      const next = responses.shift()
      if (next === undefined) throw new Error('unexpected extra call')
      if (next.startsWith('THROW:')) throw new Error(next.slice(6))
      return next
    },
    request: { feature: 'recap-period', model: 'test/model' },
    emit: (level, message) => logs.push(`${level}: ${message}`),
    ...overrides,
  }
  return { runner: base, calls, logs }
}

describe('runMapChunk', () => {
  test('a clean response parses and is trusted, with no second call', async () => {
    const { runner: r, calls } = runner([GOOD])
    const result = await runMapChunk(r, chunk())
    expect(result.outcome).toBe('parsed')
    expect(result.failure).toBeUndefined()
    expect(result.metadata.bugs).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  test('the incident response re-asks once and trusts the repair', async () => {
    const { runner: r, calls, logs } = runner([INCIDENT, GOOD])
    const result = await runMapChunk(r, chunk())
    expect(result.outcome).toBe('parsed')
    expect(result.failure).toBeUndefined()
    expect(calls.map(c => c.stage)).toEqual(['map', 'map-repair'])
    expect(logs.join('\n')).toContain('re-asking once')
  })

  test('the repair call feeds the malformed output back for correction', async () => {
    const { runner: r, calls } = runner([INCIDENT, GOOD])
    await runMapChunk(r, chunk())
    const messages = calls[1]?.req.messages ?? []
    expect(messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(messages[2]?.content).toBe(INCIDENT)
    expect(messages[3]?.content).toContain('never bare strings')
    // Second bite at the same document: no timeout retry, deterministic.
    expect(calls[1]?.req.temperature).toBe(0)
    expect(calls[1]?.req.timeoutRetries).toBe(0)
  })

  test('when the repair is also malformed, the salvage is kept rather than the chunk lost', async () => {
    const { runner: r, calls } = runner([INCIDENT, 'still not json'])
    const result = await runMapChunk(r, chunk())
    expect(result.outcome).toBe('salvaged')
    expect(calls).toHaveLength(2)
    // 29 of 32 items survive -- the whole point.
    expect(result.metadata.goals).toHaveLength(3)
    expect(result.metadata.gotchas).toHaveLength(1)
    expect(result.failure?.recovered).toBe(29)
    expect(result.failure?.dropped).toBe(3)
    expect(result.failure?.reAsked).toBe(true)
  })

  test('a salvaged chunk names the conversation it belongs to', async () => {
    const { runner: r } = runner([INCIDENT, 'nope'])
    const result = await runMapChunk(r, chunk())
    expect(result.failure?.conversations).toEqual([{ id: '488cbece-b42', title: 'AWS SES production access' }])
    expect(result.failure?.chunkIndex).toBe(148)
    expect(result.failure?.detail).toContain('dead_ends')
  })

  test('a response that recovers whole skips the re-ask entirely', async () => {
    // Trailing comma: malformed JSON, but every fact is intact.
    const { runner: r, calls, logs } = runner(['{"goals":["a","b"],}'])
    const result = await runMapChunk(r, chunk())
    expect(result.outcome).toBe('salvaged')
    expect(result.metadata.goals).toEqual(['a', 'b'])
    expect(calls).toHaveLength(1)
    expect(result.failure?.dropped).toBe(0)
    expect(logs.join('\n')).toContain('no re-ask needed')
  })

  test('a truncated response is not re-asked -- it is a sizing problem', async () => {
    const huge = `{"goals":[${Array.from({ length: 4000 }, (_, i) => `"goal ${i} ${'x'.repeat(20)}"`).join(',')},"cut`
    expect(huge.length).toBeGreaterThan(50_000)
    const { runner: r, calls, logs } = runner([huge])
    const result = await runMapChunk(r, chunk())
    expect(result.outcome).toBe('salvaged')
    expect(calls).toHaveLength(1)
    expect(result.metadata.goals).toHaveLength(4000)
    expect(logs.join('\n')).toContain('CLAUDWERK_RECAP_CHUNK_SIZE_CHARS')
  })

  test('a truncated response with nothing recoverable still keeps its truncation label', async () => {
    // Regression: an earlier ordering only labelled truncation when salvage
    // recovered something, so the worst case -- cut off before the first
    // complete element -- lost the one hint that says which knob to turn, and
    // burned a re-ask that was always going to overflow the same cap.
    const truncated = `{"keywords":["${'x'.repeat(60_000)}`
    const { runner: r, calls, logs } = runner([truncated])
    const result = await runMapChunk(r, chunk())
    expect(result.outcome).toBe('failed')
    expect(calls).toHaveLength(1)
    expect(logs.join('\n')).toContain('truncated at the token cap')
    expect(result.failure?.error).toContain('truncated at the token cap')
  })

  test('nothing recoverable and no repair -> failed, with an empty extraction', async () => {
    const { runner: r } = runner(['I cannot help with that.', 'still cannot'])
    const result = await runMapChunk(r, chunk())
    expect(result.outcome).toBe('failed')
    expect(result.metadata.goals).toEqual([])
    expect(result.failure?.outcome).toBe('failed')
    expect(result.failure?.conversations[0]?.id).toBe('488cbece-b42')
  })

  test('repair:false spends nothing and falls straight to salvage', async () => {
    const { runner: r, calls } = runner([INCIDENT], { repair: false })
    const result = await runMapChunk(r, chunk())
    expect(result.outcome).toBe('salvaged')
    expect(calls).toHaveLength(1)
    expect(result.failure?.reAsked).toBe(false)
  })

  test('a transport error propagates instead of being mistaken for bad output', async () => {
    const { runner: r } = runner(['THROW:map stage deadline exceeded'])
    await expect(runMapChunk(r, chunk())).rejects.toThrow('map stage deadline exceeded')
  })

  test('a transport error during the REPAIR propagates too', async () => {
    const { runner: r } = runner([INCIDENT, 'THROW:cancelled by caller'])
    await expect(runMapChunk(r, chunk())).rejects.toThrow('cancelled by caller')
  })
})
