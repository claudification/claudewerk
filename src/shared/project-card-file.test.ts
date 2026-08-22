/**
 * `renamed_from:` from disk to the wire shape.
 *
 * The half nobody sees fail: the epic engine's rename fold (epic-card-rename.ts)
 * is exercised against hand-built cards, so it stays green even if the key is
 * never read off a real file. These read the actual frontmatter, including the
 * bare-scalar spelling the one card carrying it today actually uses.
 */

import { describe, expect, test } from 'bun:test'
import { readRawCard, serializeCard, toProjectTask } from './project-card-file'

function parse(frontmatter: string) {
  const raw = readRawCard('/nonexistent/card.md', `---\n${frontmatter}---\n\nBody.\n`)
  if (!raw) throw new Error('unreadable')
  return toProjectTask(raw, 'card')
}

describe('renamed_from', () => {
  test('a bare id reads as a one-entry history -- the spelling cards on the board use', () => {
    expect(parse('title: A card\nstatus: open\nrenamed_from: old-long-id\n').renamedFrom).toEqual(['old-long-id'])
  })

  test('a list reads as every id in it, for a card renamed more than once', () => {
    expect(parse('title: A card\nstatus: open\nrenamed_from: [first, second]\n').renamedFrom).toEqual([
      'first',
      'second',
    ])
  })

  /** Absent and empty are the same fact, and projecting `[]` would make every
   *  card on the board claim a rename history it does not have. */
  test('is absent when the key is, and when the key says nothing', () => {
    expect(parse('title: A card\nstatus: open\n').renamedFrom).toBeUndefined()
    expect(parse('title: A card\nstatus: open\nrenamed_from:\n').renamedFrom).toBeUndefined()
  })

  test('survives a round trip -- a rename is not undone by the next card write', () => {
    const raw = readRawCard('/nonexistent/card.md', '---\ntitle: A\nstatus: open\nrenamed_from: old\n---\n\nBody.\n')
    expect(serializeCard(raw?.meta ?? {}, raw?.body ?? '', raw?.raw ?? {})).toContain('renamed_from: old')
  })
})

/**
 * The same seam one key over, and it matters more here: `epic-ready.ts` refuses
 * to dispatch a card whose `requires_deploy:` the running build cannot satisfy,
 * and a key that never made it off disk into the wire shape would turn that
 * refusal into a silent no-op -- which is precisely the class of failure the key
 * exists to prevent.
 */
describe('requires_deploy', () => {
  test('a bare token reads as a one-entry precondition', () => {
    expect(parse('title: A\nstatus: open\nrequires_deploy: needs-werk-master-tag\n').requiresDeploy).toEqual([
      'needs-werk-master-tag',
    ])
  })

  test('a list reads as every token in it', () => {
    expect(parse('title: A\nstatus: open\nrequires_deploy: [one, two]\n').requiresDeploy).toEqual(['one', 'two'])
  })

  test('is absent when the key is, and when the key says nothing', () => {
    expect(parse('title: A\nstatus: open\n').requiresDeploy).toBeUndefined()
    expect(parse('title: A\nstatus: open\nrequires_deploy:\n').requiresDeploy).toBeUndefined()
  })

  test('an UNRECOGNISED token still projects -- dropping it would read as "no preconditions"', () => {
    expect(parse('title: A\nstatus: open\nrequires_deploy: invented-next-year\n').requiresDeploy).toEqual([
      'invented-next-year',
    ])
  })

  test("survives a round trip -- a board write must not clear a card's own gate", () => {
    const raw = readRawCard('/nonexistent/card.md', '---\ntitle: A\nstatus: open\nrequires_deploy: [tok]\n---\n\nB.\n')
    expect(serializeCard(raw?.meta ?? {}, raw?.body ?? '', raw?.raw ?? {})).toContain('requires_deploy: [tok]')
  })
})
