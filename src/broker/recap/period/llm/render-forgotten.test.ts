import { describe, expect, it } from 'bun:test'
import type { ForgottenThreadDigest } from '../gather/types'
import { renderForgottenSection } from './render-forgotten'

describe('renderForgottenSection', () => {
  it('returns empty string when there are no threads (section omitted)', () => {
    expect(renderForgottenSection({ threads: [], candidateCount: 0, probed: 0 })).toBe('')
  })

  it('renders each thread with id, idle age, turns, last user, left-at, and open question', () => {
    const digest: ForgottenThreadDigest = {
      threads: [
        {
          conversationId: 'conv_abc123def456',
          conversationTitle: '',
          projectUri: 'claude://default/p',
          idleDays: 21,
          turnCount: 34,
          lastUserPrompt: 'wire up the cache layer',
          finalAssistantText: 'I scaffolded it. Which TTL do you want?',
          openQuestions: ['Which TTL do you want?'],
        },
      ],
      candidateCount: 5,
      probed: 5,
    }
    const out = renderForgottenSection(digest)
    expect(out).toContain('FORGOTTEN_THREADS')
    expect(out).toContain('idle 21d, 34 turns')
    expect(out).toContain('LAST USER: wire up the cache layer')
    expect(out).toContain('OPEN: Which TTL do you want?')
    // 5 candidates, 1 shown -> 4 not shown
    expect(out).toContain('4 more')
  })
})
