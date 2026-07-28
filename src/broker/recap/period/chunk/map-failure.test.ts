import { describe, expect, test } from 'bun:test'
import type { RecapChunkFailure } from '../../../../shared/protocol'
import { describeConversation, describeFailure, describePartial, lostChunk, salvagedChunk } from './map-failure'
import { salvageMapOutput } from './salvage'
import type { TranscriptChunk } from './split'

function chunk(index: number, id: string, title: string): TranscriptChunk {
  return {
    index,
    chars: 100,
    partialConversationIds: [],
    transcripts: [{ conversationId: id, conversationTitle: title, turns: [] }],
  }
}

describe('describeConversation', () => {
  test('titles it with a short id', () => {
    expect(describeConversation({ id: '488cbece-b42-long', title: 'AWS SES' })).toBe('AWS SES (488cbece)')
  })

  test('falls back to the id when there is no title', () => {
    expect(describeConversation({ id: '488cbece-b42', title: '' })).toBe('488cbece')
    expect(describeConversation({ id: '488cbece-b42', title: '   ' })).toBe('488cbece')
  })
})

describe('describeFailure', () => {
  test('a dropped chunk says so, with the conversation named', () => {
    const f = lostChunk(chunk(148, '488cbece-b42', 'AWS SES'), 'map JSON parse failed')
    expect(describeFailure(f)).toBe('AWS SES (488cbece) -- dropped entirely: map JSON parse failed')
  })

  test('a salvaged chunk reports how much was lost, not just that it broke', () => {
    const salvage = salvageMapOutput('{"goals":["a"],"dead_ends":["bare",{"title":"x"}]}')
    const f = salvagedChunk(chunk(148, '488cbece', 'AWS SES'), salvage, 'detail', 'parse failed', true)
    expect(describeFailure(f)).toContain('partially recovered (1 fact(s) lost)')
  })

  test('a chunk with no conversations still identifies itself', () => {
    const f: RecapChunkFailure = { chunkIndex: 4, outcome: 'failed', conversations: [], error: 'boom', at: 0 }
    expect(describeFailure(f)).toContain('chunk 5')
  })
})

describe('describePartial', () => {
  test('names the conversation instead of counting chunks', () => {
    const reason = describePartial(
      [lostChunk(chunk(148, '488cbece-b42', 'AWS SES production access'), 'bad json')],
      169,
    )
    // The line that replaces "1 of 169 chunk(s) failed -- recap is partial".
    expect(reason).toBe('1 conversation(s) dropped of 169 -- AWS SES production access (488cbece)')
  })

  test('distinguishes dropped from partially recovered', () => {
    const salvage = salvageMapOutput('{"goals":["a"],"bugs":["bare"]}')
    const reason = describePartial(
      [
        lostChunk(chunk(1, 'aaaaaaaa', 'One'), 'bad'),
        salvagedChunk(chunk(2, 'bbbbbbbb', 'Two'), salvage, 'd', 'e', true),
      ],
      10,
    )
    expect(reason).toContain('1 conversation(s) dropped')
    expect(reason).toContain('1 partially recovered')
    expect(reason).toContain('One (aaaaaaaa)')
    expect(reason).toContain('Two (bbbbbbbb)')
  })

  test('truncates a long list but says how many it is hiding -- never pretends to be complete', () => {
    const failures = Array.from({ length: 7 }, (_, i) => lostChunk(chunk(i, `conv${i}aaa`, `Conv ${i}`), 'bad'))
    const reason = describePartial(failures, 169)
    expect(reason).toContain('+4 more')
    expect(reason).toContain('Conv 0')
    expect(reason).not.toContain('Conv 5')
  })

  test('no failures means no reason', () => {
    expect(describePartial([], 10)).toBe('')
  })
})
