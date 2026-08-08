/**
 * Parsing the fork provenance block out of a transcript entry.
 *
 * These pin the round-trip against the renderer in src/shared/fork-provenance.ts
 * -- if either side drifts, a forked conversation silently shows raw pseudo-XML
 * instead of the header card.
 */
import { describe, expect, it } from 'vitest'
import { hasForkProvenance, parseForkProvenance } from './fork-provenance-parse'

const BLOCK = [
  '<forked from_conversation="conv_abc123" from_name="Slug hunt">',
  'This conversation was forked from "Slug hunt" (conversation id conv_abc123).',
  '</forked>',
].join('\n')

describe('hasForkProvenance', () => {
  it('is true for a block and false for ordinary text', () => {
    expect(hasForkProvenance(BLOCK)).toBe(true)
    expect(hasForkProvenance('just a normal message about forking code')).toBe(false)
  })
})

describe('parseForkProvenance', () => {
  it('extracts the parent id and name', () => {
    const p = parseForkProvenance(BLOCK)
    expect(p?.conversationId).toBe('conv_abc123')
    expect(p?.conversationName).toBe('Slug hunt')
  })

  it('returns the fold preamble that followed the block as rest', () => {
    const p = parseForkProvenance(`${BLOCK}\n\n[super-compacted context]\n\n38 turns were folded.`)
    expect(p?.rest).toContain('[super-compacted context]')
    expect(p?.rest).not.toContain('<forked')
  })

  it('handles a block with no name', () => {
    const p = parseForkProvenance('<forked from_conversation="conv_x">body</forked>')
    expect(p?.conversationId).toBe('conv_x')
    expect(p?.conversationName).toBeUndefined()
  })

  // The renderer JSON-escapes from_name so a quote in the title cannot break
  // the tag; the parser has to undo exactly that.
  it('unescapes a quoted name', () => {
    const p = parseForkProvenance('<forked from_conversation="c1" from_name="the \\"big\\" fix">x</forked>')
    expect(p?.conversationName).toBe('the "big" fix')
  })

  it('returns null when there is no block', () => {
    expect(parseForkProvenance('nothing here')).toBeNull()
  })
})
