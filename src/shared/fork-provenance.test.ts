/**
 * The provenance block a fork carries about its parent.
 *
 * The thing worth pinning is that it stays ACTIONABLE: a parseable open tag for
 * the transcript renderer, and tool calls with the parent id already filled in
 * so recovering detail is a copy-paste, not a puzzle.
 */
import { describe, expect, test } from 'bun:test'
import { renderForkProvenance } from './fork-provenance'

const BASE = { conversationId: 'conv_abc123', conversationName: 'Slug hunt' }

describe('renderForkProvenance', () => {
  test('opens with a parseable tag carrying id and name', () => {
    const out = renderForkProvenance({ ...BASE, mode: 'condensed' })
    expect(out.startsWith('<forked from_conversation="conv_abc123" from_name="Slug hunt">')).toBe(true)
    expect(out.trimEnd().endsWith('</forked>')).toBe(true)
  })

  test('names both recovery tools with the parent id already substituted', () => {
    const out = renderForkProvenance({ ...BASE, mode: 'condensed' })
    expect(out).toContain('search_transcripts({ conversationId: "conv_abc123", query: "<terms>" })')
    expect(out).toContain('get_transcript_context({ conversationId: "conv_abc123"')
  })

  test('condensed says detail was elided and is recoverable', () => {
    const out = renderForkProvenance({ ...BASE, mode: 'condensed' })
    expect(out).toContain('CONDENSED')
    expect(out).toContain('recoverable in full')
  })

  test('summarized says the transcript was NOT provided', () => {
    const out = renderForkProvenance({ ...BASE, mode: 'summarized' })
    expect(out).toContain('NOT been given')
  })

  // A full copy elided nothing. Telling the agent otherwise sends it hunting
  // for detail that is already in front of it.
  test('full does not claim anything was dropped', () => {
    const out = renderForkProvenance({ ...BASE, mode: 'full' })
    expect(out).toContain('complete copy')
    expect(out).not.toContain('CONDENSED')
    expect(out).not.toContain('NOT been given')
  })

  test('survives a missing parent name without emitting an empty attribute', () => {
    const out = renderForkProvenance({ conversationId: 'conv_x', mode: 'condensed' })
    expect(out).toContain('<forked from_conversation="conv_x">')
    expect(out).not.toContain('from_name=')
    expect(out).toContain('an earlier session')
  })

  test('escapes a name containing quotes so the tag stays parseable', () => {
    const out = renderForkProvenance({ conversationId: 'c1', conversationName: 'the "big" fix', mode: 'condensed' })
    expect(out).toContain('from_name="the \\"big\\" fix"')
  })
})
