/**
 * A card whose linkage is spelled as a YAML block list.
 *
 * Three live cards were written that way -- the natural spelling for a human --
 * and the board read `refs:` as empty and the `relates_to` edge as absent. The
 * store seam is where this has to be pinned: `parseBlockSequence` passing in
 * isolation is exactly the guarantee `relates_to` already had for the months it
 * spent doing nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCardFrontmatter } from './card-frontmatter'
import { readLinkage } from './card-linkage-read'
import { cardPath, createProjectTask, getProjectTask, updateProjectTask } from './project-store'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'card-frontmatter-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const NOW = 1_770_000_000_000

const onDisk = (id: string) => readFileSync(cardPath(root, id), 'utf8')

function writeRawCard(id: string, frontmatter: string): void {
  createProjectTask(root, { title: id, body: 'placeholder' }, NOW)
  writeFileSync(cardPath(root, id), `---\n${frontmatter}\n---\n\nbody\n`, 'utf8')
}

/** `archive-ndjson-test-load-flake` as it actually sits on the board. */
const BLOCK_LIST_CARD = [
  'title: A',
  'status: open',
  'refs:',
  '  - src/broker/archive/__tests__/ndjson.test.ts',
  'relates_to:',
  '  - launch-handoff-test-load-flake',
  '  - flaky-launch-handoff-test',
].join('\n')

describe('a block-list linkage key is READ, not merely preserved', () => {
  test('parseCardFrontmatter lands it in meta, not in raw', () => {
    const { meta, raw } = parseCardFrontmatter(`---\n${BLOCK_LIST_CARD}\n---\n\nbody\n`)
    expect(meta.refs).toEqual(['src/broker/archive/__tests__/ndjson.test.ts'])
    expect(meta.relates_to).toEqual(['launch-handoff-test-load-flake', 'flaky-launch-handoff-test'])
    expect(raw).toEqual({})
  })

  test('readLinkage reports the edge the board was missing', () => {
    const { meta } = parseCardFrontmatter(`---\n${BLOCK_LIST_CARD}\n---\n\nbody\n`)
    expect(readLinkage(meta).relates_to).toEqual(['launch-handoff-test-load-flake', 'flaky-launch-handoff-test'])
  })

  test('through the store, on the wire shape', () => {
    writeRawCard('a', BLOCK_LIST_CARD)
    const task = getProjectTask(root, 'a')
    expect(task?.refs).toEqual(['src/broker/archive/__tests__/ndjson.test.ts'])
    expect(task?.relatesTo).toEqual(['launch-handoff-test-load-flake', 'flaky-launch-handoff-test'])
  })

  test('and the next write heals it to the inline spelling', () => {
    writeRawCard('a', BLOCK_LIST_CARD)
    updateProjectTask(root, 'a', { priority: 'high' })
    expect(onDisk('a')).toContain('relates_to: [launch-handoff-test-load-flake, flaky-launch-handoff-test]')
    expect(onDisk('a')).not.toContain('  - launch-handoff-test-load-flake')
    expect(getProjectTask(root, 'a')?.relatesTo).toEqual([
      'launch-handoff-test-load-flake',
      'flaky-launch-handoff-test',
    ])
  })

  test('a quoted item keeps its value and loses its quotes', () => {
    writeRawCard('a', 'title: A\nstatus: open\ntags:\n  - "a: b"\n  - plain')
    expect(getProjectTask(root, 'a')?.tags).toEqual(['a: b', 'plain'])
  })
})

describe('the fold is gated by the SCHEMA, so it cannot reach a nested block', () => {
  const withBlock = (block: string) => parseCardFrontmatter(`---\ntitle: A\n${block}\n---\n\nbody\n`)

  test('a promise mapping is untouched -- promise-ledger.ts still owns it', () => {
    const { meta, raw } = withBlock('promise:\n  closes:\n    - x')
    expect(raw.promise).toEqual(['promise:', '  closes:', '    - x'])
    expect(meta.promise).toBeUndefined()
  })

  test('an unknown key spelled as a list stays a verbatim block', () => {
    const { meta, raw } = withBlock('invented_key:\n  - a')
    expect(raw.invented_key).toEqual(['invented_key:', '  - a'])
    expect(meta.invented_key).toBeUndefined()
  })

  test('a one-arity verb is not a list, so it is left alone', () => {
    const { raw } = withBlock('epic:\n  - some-epic')
    expect(raw.epic).toEqual(['epic:', '  - some-epic'])
  })

  test('a list-typed key holding a MAPPING is left alone too', () => {
    const { raw } = withBlock('refs:\n  - path: src/x.ts')
    expect(raw.refs).toEqual(['refs:', '  - path: src/x.ts'])
  })

  test('a card with no blocks at all is byte-identical through a write', () => {
    writeRawCard('a', 'title: A\nstatus: open\nrefs: [x, y]')
    const before = onDisk('a')
    updateProjectTask(root, 'a', { title: 'A' })
    expect(onDisk('a')).toBe(before)
  })
})

describe('preserve-unknown-keys survives the fold', () => {
  test('a promise block and a folded refs coexist on one card', () => {
    writeRawCard('a', 'title: A\nstatus: open\nrefs:\n  - src/x.ts\npromise:\n  closes:\n    - y')
    updateProjectTask(root, 'a', { priority: 'low' })
    const raw = onDisk('a')
    expect(raw).toContain('refs: [src/x.ts]')
    expect(raw).toContain('promise:\n  closes:\n    - y')
    expect(getProjectTask(root, 'a')?.refs).toEqual(['src/x.ts'])
  })
})
