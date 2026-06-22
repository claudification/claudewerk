import { describe, expect, test } from 'bun:test'
import type { ChatRequest, ChatResponse } from '../recap/shared/openrouter-client'
import { condenseBrief, MAX_BRIEF_CHARS } from './condenser'
import type { RawEvent } from './project-memory'

function ev(id: number, summary: string): RawEvent {
  return { id, kind: 'turn_complete', conversationId: null, summary, ts: id }
}
function stubChat(content: string, capture?: (r: ChatRequest) => void) {
  return async (req: ChatRequest): Promise<ChatResponse> => {
    capture?.(req)
    return { content, raw: {}, usage: {} as never, model: req.model }
  }
}

describe('condenseBrief', () => {
  test('returns the model brief, trimmed', () => {
    const out = condenseBrief(
      { label: 'arr', projectUri: 'claude://d/arr', currentBrief: '', events: [ev(1, 'turn ended')] },
      stubChat('  Arr is a media indexer.  '),
    )
    return out.then(b => expect(b).toBe('Arr is a media indexer.'))
  })

  test('feeds current brief + new signal + recap excerpts into the prompt', async () => {
    let seen: ChatRequest | undefined
    await condenseBrief(
      {
        label: 'arr',
        projectUri: 'claude://d/arr',
        currentBrief: 'old brief here',
        events: [ev(1, 'spawned indexer')],
        recapExcerpts: ['Auth landed — token refresh'],
      },
      stubChat('next', r => {
        seen = r
      }),
    )
    expect(seen?.user).toContain('old brief here')
    expect(seen?.user).toContain('spawned indexer')
    expect(seen?.user).toContain('Auth landed')
  })

  test('caps an over-long brief', async () => {
    const huge = 'x'.repeat(MAX_BRIEF_CHARS + 500)
    const b = await condenseBrief(
      { label: 'p', projectUri: 'claude://d/p', currentBrief: '', events: [ev(1, 'a')] },
      stubChat(huge),
    )
    expect(b.length).toBeLessThanOrEqual(MAX_BRIEF_CHARS + 1) // +1 for the ellipsis
    expect(b.endsWith('…')).toBe(true)
  })

  test('on LLM failure keeps the current brief (memory never regresses)', async () => {
    const failing = async (): Promise<ChatResponse> => {
      throw new Error('down')
    }
    const b = await condenseBrief(
      { label: 'p', projectUri: 'claude://d/p', currentBrief: 'keep me', events: [ev(1, 'a')] },
      failing,
    )
    expect(b).toBe('keep me')
  })

  test('empty model reply keeps the current brief', async () => {
    const b = await condenseBrief(
      { label: 'p', projectUri: 'claude://d/p', currentBrief: 'keep me', events: [ev(1, 'a')] },
      stubChat('   '),
    )
    expect(b).toBe('keep me')
  })
})
