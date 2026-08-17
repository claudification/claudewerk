/**
 * The board section of the system prompt is the ONLY thing most agents ever
 * learn about card frontmatter. On 2026-08-17 it listed title/priority/tags/
 * refs/created and nothing else, so an agent asked to build an epic did the
 * only thing the prompt allowed: it wrote a parent-side `blocks: [children]`
 * list -- the exact anti-pattern `epic-cards.ts` was written to replace.
 * Ten cards landed with no `epic:` key and the epic rendered as a plain card.
 *
 * These assertions are the contract: if a frontmatter key is structural to the
 * board, the prompt names it.
 */

import { describe, expect, it } from 'bun:test'
import { EPIC_TAG } from '../shared/epic-cards'
import { buildSystemPrompt } from './prompt-builder'

const board = (): string => {
  const full = buildSystemPrompt({ channelEnabled: false, headless: false })
  const start = full.indexOf('# Project Board (rclaude)')
  expect(start).toBeGreaterThan(-1)
  return full.slice(start)
}

describe('buildSystemPrompt project board section', () => {
  it('documents child-side epic parenthood', () => {
    expect(board()).toContain('`epic:`')
  })

  it('documents depends_on as sequencing', () => {
    expect(board()).toContain('`depends_on:`')
  })

  it('names the tag that marks a card as an epic', () => {
    expect(board()).toContain(`tags: [..., ${EPIC_TAG}]`)
  })

  it('marks an alias as an alias instead of restating its stored form', () => {
    const text = board()
    expect(text).toContain('`blocked_by:` -- alias for `depends_on:`')
    expect(text).toContain('`see_also:` -- alias for `relates_to:`')
  })

  it('warns that the deprecated parent-side key is computed now', () => {
    expect(board()).toContain('**DEPRECATED**')
  })

  it('tells the agent NOT to hand-maintain a parent-side child list', () => {
    expect(board()).toContain('`blocks:`')
  })

  it('still documents the lane key and the original frontmatter keys', () => {
    const text = board()
    for (const key of ['status:', 'title', 'priority', 'tags', 'refs', 'created']) {
      expect(text).toContain(key)
    }
  })
})
