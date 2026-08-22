import { describe, expect, test } from 'bun:test'
import { renameNeedsOverseerTag } from './werk-tag-rename'

const card = (front: string, body = 'Some body prose.\n') => `---\n${front}\n---\n\n${body}`

describe('renameNeedsOverseerTag', () => {
  test('rewrites the tag in a list', () => {
    const out = renameNeedsOverseerTag(card('title: "q"\nstatus: open\ntags: [needs-overseer]'))
    expect(out).toContain('tags: [needs-werk-master]')
  })

  test('keeps the other tags and their order', () => {
    const out = renameNeedsOverseerTag(card('tags: [needs-overseer, epic-engine, dispatch, werk]'))
    expect(out).toContain('tags: [needs-werk-master, epic-engine, dispatch, werk]')
  })

  /** An mtime bump on every card is what makes the nightly board sweep think
   *  the whole board moved, so "unchanged" has to be distinguishable. */
  test('a card without the tag returns null rather than an identical string', () => {
    expect(renameNeedsOverseerTag(card('tags: [werk, naming]'))).toBeNull()
    expect(renameNeedsOverseerTag(card('title: "no tags line"'))).toBeNull()
  })

  /**
   * BODY PROSE IS SOMEBODY'S ARGUMENT, not a stored tag. Cards written before
   * the rename say "raise a `needs-overseer` question" as a statement about
   * what the code did at the time; editing that to make a grep come out clean
   * is rewriting history, and 21 of the 32 cards mentioning the word mention it
   * exactly this way.
   */
  test('leaves the word alone in the body', () => {
    const out = renameNeedsOverseerTag(card('tags: [needs-overseer]', 'File a `needs-overseer` card instead.\n'))
    expect(out).toContain('tags: [needs-werk-master]')
    expect(out).toContain('File a `needs-overseer` card instead.')
  })

  test('leaves a longer tag that merely starts with the word alone', () => {
    expect(renameNeedsOverseerTag(card('tags: [needs-overseer-later]'))).toBeNull()
  })

  test('a file with no frontmatter block is not touched', () => {
    expect(renameNeedsOverseerTag('tags: [needs-overseer]\n')).toBeNull()
    expect(renameNeedsOverseerTag('---\ntags: [needs-overseer]\n')).toBeNull()
  })

  test('running it twice changes nothing the second time', () => {
    const once = renameNeedsOverseerTag(card('tags: [needs-overseer]'))
    expect(once).not.toBeNull()
    expect(renameNeedsOverseerTag(once as string)).toBeNull()
  })

  test('every byte outside the tags line survives', () => {
    const input = card('title: "q1"\nstatus: open\ntags: [needs-overseer]\npriority: high\nepic: epic-werk-agile-loop')
    const out = renameNeedsOverseerTag(input) as string
    expect(out.split('\n').filter(l => !l.startsWith('tags:'))).toEqual(
      input.split('\n').filter(l => !l.startsWith('tags:')),
    )
  })
})
