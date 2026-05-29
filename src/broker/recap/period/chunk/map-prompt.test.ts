import { describe, expect, it } from 'bun:test'
import type { TranscriptDigest } from '../gather/types'
import { buildMapPrompt, MAP_SYSTEM_PROMPT, MapParseError, parseMapOutput } from './map-prompt'
import type { TranscriptChunk } from './split'

function chunk(overrides: Partial<TranscriptChunk> = {}): TranscriptChunk {
  const transcripts: TranscriptDigest[] = [
    {
      // <=12 chars so shortId renders it whole (it truncates longer ids).
      conversationId: 'conv_short',
      conversationTitle: 'Build the thing',
      turns: [{ userPrompt: 'do X', assistantFinal: 'did X' }] as TranscriptDigest['turns'],
    },
  ]
  return { index: 0, transcripts, chars: 100, partialConversationIds: [], ...overrides }
}

describe('parseMapOutput', () => {
  it('parses a full extraction object into RecapMetadata shape', () => {
    const raw = JSON.stringify({
      keywords: ['orchestrator.ts', 'ledger'],
      hashtags: ['#recap'],
      goals: ['ship chunking'],
      discoveries: ['cache tokens already tracked'],
      side_effects: [],
      open_questions: ['deploy now?'],
      stakeholders: ['Jonas'],
      features: [
        {
          title: 'chunked map-reduce',
          detail: 'split/map/merge',
          conversations: ['conv_aaaaaaaa'],
          commits: ['abc1234'],
        },
      ],
      bugs: [],
      fixes: [{ title: 'dedup by title+commit' }],
      incidents: [],
      decisions: [{ title: 'JSON for map stage', inferred: true }],
      dead_ends: [],
      gotchas: [],
    })
    const meta = parseMapOutput(raw)
    expect(meta.keywords).toEqual(['orchestrator.ts', 'ledger'])
    expect(meta.stakeholders).toEqual(['Jonas'])
    expect(meta.features).toHaveLength(1)
    expect(meta.features[0]).toEqual({
      title: 'chunked map-reduce',
      detail: 'split/map/merge',
      conversations: ['conv_aaaaaaaa'],
      commits: ['abc1234'],
    })
    expect(meta.fixes[0]).toEqual({ title: 'dedup by title+commit' })
    expect(meta.decisions[0]).toEqual({ title: 'JSON for map stage', inferred: true })
  })

  it('recovers JSON wrapped in markdown fences or prose', () => {
    const raw = 'Sure! Here is the JSON:\n```json\n{"keywords":["a"],"features":[]}\n```\nHope this helps'
    const meta = parseMapOutput(raw)
    expect(meta.keywords).toEqual(['a'])
  })

  it('defaults missing keys to empty arrays', () => {
    const meta = parseMapOutput('{"keywords":["only"]}')
    expect(meta.keywords).toEqual(['only'])
    expect(meta.features).toEqual([])
    expect(meta.bugs).toEqual([])
    expect(meta.open_questions).toEqual([])
  })

  it('drops items without a title and trims string lists', () => {
    const raw = JSON.stringify({
      keywords: ['  spaced  ', '', '   '],
      features: [{ detail: 'no title here' }, { title: '   ' }, { title: 'real' }],
    })
    const meta = parseMapOutput(raw)
    expect(meta.keywords).toEqual(['spaced'])
    expect(meta.features).toEqual([{ title: 'real' }])
  })

  it('throws MapParseError when there is no JSON object at all', () => {
    expect(() => parseMapOutput('I could not produce JSON, sorry.')).toThrow(MapParseError)
  })

  it('throws MapParseError on malformed JSON', () => {
    expect(() => parseMapOutput('{"keywords": [unquoted]}')).toThrow(MapParseError)
  })
})

describe('buildMapPrompt', () => {
  it('uses the stable constant system prompt (cache-friendly, no per-chunk text)', () => {
    const a = buildMapPrompt(chunk({ index: 0 }))
    const b = buildMapPrompt(chunk({ index: 3 }))
    expect(a.system).toBe(MAP_SYSTEM_PROMPT)
    expect(b.system).toBe(MAP_SYSTEM_PROMPT)
  })

  it('renders the chunk transcripts into the user message and asks for JSON only', () => {
    const { user } = buildMapPrompt(chunk())
    expect(user).toContain('conv_short')
    expect(user).toContain('Build the thing')
    expect(user).toContain('do X')
    expect(user.toLowerCase()).toContain('json only')
  })

  it('flags partial conversations so the model does not speculate about missing turns', () => {
    const { user } = buildMapPrompt(chunk({ partialConversationIds: ['conv_short'] }))
    expect(user).toContain('only PART of conversation')
    expect(user).toContain('conv_short')
  })
})
