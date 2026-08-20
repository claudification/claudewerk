import { describe, expect, it } from 'bun:test'
import { parseBlockSequence, parseFrontmatter, serializeFrontmatter } from './frontmatter'

describe('parseFrontmatter quoting', () => {
  it('strips double quotes', () => {
    // The bug: every board card whose title contains a colon must be quoted for
    // YAML, and every one of them rendered in the panel wrapped in literal ".
    const { meta } = parseFrontmatter('---\ntitle: "EPIC: Unify spawn surface"\n---\nbody')
    expect(meta.title).toBe('EPIC: Unify spawn surface')
  })

  it('strips single quotes', () => {
    const { meta } = parseFrontmatter("---\ntitle: 'ANVIL epic: inline language'\n---\nbody")
    expect(meta.title).toBe('ANVIL epic: inline language')
  })

  it('leaves an unquoted scalar alone', () => {
    const { meta } = parseFrontmatter('---\nstatus: open\n---\nbody')
    expect(meta.status).toBe('open')
  })

  it('does not strip a quote that is only on one side', () => {
    const { meta } = parseFrontmatter('---\ntitle: "unbalanced\n---\nbody')
    expect(meta.title).toBe('"unbalanced')
  })

  it('does not strip quotes that merely appear inside the value', () => {
    const { meta } = parseFrontmatter('---\ntitle: he said "hi" loudly\n---\nbody')
    expect(meta.title).toBe('he said "hi" loudly')
  })

  it('unescapes \\" inside a double-quoted scalar', () => {
    const { meta } = parseFrontmatter('---\ntitle: "the \\"good\\" parts"\n---\nbody')
    expect(meta.title).toBe('the "good" parts')
  })

  it('handles an empty quoted string', () => {
    const { meta } = parseFrontmatter('---\ntitle: ""\n---\nbody')
    expect(meta.title).toBe('')
  })

  it('still parses inline arrays', () => {
    const { meta } = parseFrontmatter('---\ntags: [a, b, c]\n---\nbody')
    expect(meta.tags).toEqual(['a', 'b', 'c'])
  })
})

describe('serializeFrontmatter quoting', () => {
  it('quotes a value containing a colon so it survives a re-read', () => {
    const out = serializeFrontmatter({ title: 'EPIC: Unify spawn surface' }, 'body')
    expect(out).toContain('title: "EPIC: Unify spawn surface"')
  })

  it('leaves a plain value bare', () => {
    expect(serializeFrontmatter({ status: 'open' }, 'body')).toContain('status: open')
  })

  it('leaves an ISO timestamp bare -- a colon is only ambiguous before a space', () => {
    // Over-quoting here would rewrite the `created:` line of all 385 cards on
    // the next touch, for a value YAML was always happy with.
    const out = serializeFrontmatter({ created: '2026-08-15T06:08:44.054Z' }, 'body')
    expect(out).toContain('created: 2026-08-15T06:08:44.054Z')
  })

  it('quotes a trailing colon', () => {
    expect(serializeFrontmatter({ note: 'see also:' }, 'body')).toContain('note: "see also:"')
  })

  it('leaves a bare url alone', () => {
    expect(serializeFrontmatter({ ref: 'claude://sentinel/path' }, 'body')).toContain('ref: claude://sentinel/path')
  })

  it('escapes embedded double quotes when it quotes', () => {
    const out = serializeFrontmatter({ title: 'the "good": parts' }, 'body')
    expect(out).toContain('title: "the \\"good\\": parts"')
  })

  it('quotes a value that would otherwise read as an array', () => {
    expect(serializeFrontmatter({ note: '[not an array' }, 'body')).toContain('note: "[not an array"')
  })

  it('quotes a value with significant whitespace', () => {
    expect(serializeFrontmatter({ note: ' padded ' }, 'body')).toContain('note: " padded "')
  })
})

describe('nested blocks are captured verbatim, never flattened', () => {
  const promise = ['promise:', '  agreed: 2026-08-21', '  asked: "the ask"', '  closes:', '    - 83bf55f0']
  const text = ['---', 'title: A card', 'status: open', ...promise, 'test_cmd: bun test', '---', '', 'Body.', ''].join(
    '\n',
  )

  it('captures the block whole, parent line included', () => {
    expect(parseFrontmatter(text).raw).toEqual({ promise })
  })

  it('keeps every child OUT of meta -- the inversion that emptied `closes:`', () => {
    // The old flat reader took a key as everything before the first `:` and
    // ignored indentation, so `promise:` became an empty scalar and `agreed`,
    // `asked` and `closes` became TOP-LEVEL keys. `closes:` came back "".
    const { meta } = parseFrontmatter(text)
    expect(meta).toEqual({ title: 'A card', status: 'open', test_cmd: 'bun test' })
  })

  it('re-emits the block byte-for-byte', () => {
    const { meta, body, raw } = parseFrontmatter(text)
    expect(serializeFrontmatter(meta, body, raw)).toContain(`${promise.join('\n')}\n`)
  })

  it('is idempotent -- writing twice produces identical bytes', () => {
    const round = (t: string) => {
      const { meta, body, raw } = parseFrontmatter(t)
      return serializeFrontmatter(meta, body, raw)
    }
    const once = round(text)
    expect(round(once)).toBe(once)
  })

  it('a caller that passes no blocks behaves exactly as before', () => {
    const { meta, body } = parseFrontmatter(text)
    expect(serializeFrontmatter(meta, body)).toBe(serializeFrontmatter(meta, body, {}))
  })

  it('an empty key with nothing indented under it stays an empty scalar', () => {
    // `renamed_from:` alone is a real spelling on the board and MUST keep
    // reading as '' -- capturing it would move a key out of `meta`.
    const { meta, raw } = parseFrontmatter('---\ntitle: x\nrenamed_from:\nstatus: open\n---\nbody')
    expect(meta.renamed_from).toBe('')
    expect(raw).toEqual({})
  })

  it('a blank line inside a block does not end it', () => {
    const lines = ['promise:', '  agreed: 2026-08-21', '', '  closes:', '    - abc1234']
    const { raw } = parseFrontmatter(`---\ntitle: x\n${lines.join('\n')}\n---\nbody`)
    expect(raw.promise).toEqual(lines)
  })

  it('a blank line AFTER a block is not swallowed into it', () => {
    const { raw, meta } = parseFrontmatter('---\npromise:\n  closes: []\n\nstatus: open\n---\nbody')
    expect(raw.promise).toEqual(['promise:', '  closes: []'])
    expect(meta.status).toBe('open')
  })

  it('captures a block LIST, which the flat reader also read as ""', () => {
    const { meta, raw } = parseFrontmatter('---\ntags:\n  - a\n  - b\n---\nbody')
    expect(raw.tags).toEqual(['tags:', '  - a', '  - b'])
    expect(meta.tags).toBeUndefined()
  })

  it('captures a block SCALAR, whose indented lines used to leak in as keys', () => {
    // `note: |` + `  status: fake` injected a TOP-LEVEL `status` out of a body.
    const { meta, raw } = parseFrontmatter('---\nnote: |\n  first: line\n  second\nstatus: open\n---\nbody')
    expect(raw.note).toEqual(['note: |', '  first: line', '  second'])
    expect(meta).toEqual({ status: 'open' })
  })

  it('captures more than one block, in file order', () => {
    const { raw } = parseFrontmatter('---\na:\n  x: 1\nb:\n  y: 2\n---\nbody')
    expect(Object.keys(raw)).toEqual(['a', 'b'])
  })
})

describe('parseBlockSequence reads a captured block back, or refuses', () => {
  const block = (text: string) => parseFrontmatter(`---\n${text}\n---\nbody`).raw

  it('reads a plain sequence', () => {
    expect(parseBlockSequence(block('refs:\n  - a\n  - b').refs)).toEqual(['a', 'b'])
  })

  it('unquotes items, because a colon in a value is why it was quoted', () => {
    expect(parseBlockSequence(block('refs:\n  - "a: b"').refs)).toEqual(['a: b'])
  })

  it('takes any indent, as long as it is the same one throughout', () => {
    expect(parseBlockSequence(block('refs:\n    - a\n    - b').refs)).toEqual(['a', 'b'])
    expect(parseBlockSequence(block('refs:\n  - a\n    - b').refs)).toBeNull()
  })

  // Everything below stays a verbatim block: null is the answer that changes
  // nothing, and guessing is a reader inventing a value the file does not carry.
  it('refuses a mapping', () => {
    expect(parseBlockSequence(block('promise:\n  closes: []').promise)).toBeNull()
  })

  it('refuses a sequence of mappings', () => {
    expect(parseBlockSequence(block('refs:\n  - path: src/x.ts').refs)).toBeNull()
    expect(parseBlockSequence(block('refs:\n  - trailing:').refs)).toBeNull()
  })

  it('refuses a nested sequence', () => {
    expect(parseBlockSequence(block('refs:\n  - - a').refs)).toBeNull()
  })

  it('refuses a block scalar, whose lines may legitimately start with a dash', () => {
    expect(parseBlockSequence(block('note: |\n  - not an item').note)).toBeNull()
  })

  it('refuses a blank line mid-sequence rather than skipping it', () => {
    expect(parseBlockSequence(block('refs:\n  - a\n\n  - b').refs)).toBeNull()
  })
})

describe('frontmatter round-trip', () => {
  // The half that actually protects the cards: strip on read WITHOUT quoting on
  // write would make the next card update emit `title: EPIC: Unify ...`, and the
  // file would drift a little further from YAML on every edit.
  const CASES: Array<Record<string, unknown>> = [
    { title: 'EPIC: Unify spawn surface', status: 'open' },
    { title: 'plain title', tags: ['a', 'b'] },
    { title: 'the "good": parts' },
    { title: '' },
    { note: '[not an array' },
  ]

  for (const meta of CASES) {
    it(`survives ${JSON.stringify(meta)}`, () => {
      const text = serializeFrontmatter(meta, 'the body')
      const back = parseFrontmatter(text)
      expect(back.meta).toEqual(meta)
      expect(back.body).toBe('the body')
    })
  }
})
