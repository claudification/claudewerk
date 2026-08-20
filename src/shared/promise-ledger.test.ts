import { describe, expect, it } from 'bun:test'
import { parseFrontmatter } from './frontmatter'
import { serializeCard } from './project-card-file'
import {
  appendCloses,
  type CommitResolver,
  type CommitStanding,
  closedWithoutCommit,
  detectCardDefects,
  insertPromiseBlock,
  isOutstanding,
  isStub,
  type PromiseRow,
  parsePromiseBlock,
  promiseFromCard,
  renderPromiseBlock,
  stubs,
  verdictFor,
} from './promise-ledger'

/** A card with whatever `promise:` body the test needs. */
function card(promise: string[], extra: string[] = []): string {
  return [
    '---',
    'title: "A promise"',
    'status: open',
    ...extra,
    'promise:',
    ...promise,
    '---',
    '',
    'Body text.',
    '',
  ].join('\n')
}

const on = (sha: string): CommitStanding => ({ sha, exists: true, onMain: true })
const offMain = (sha: string): CommitStanding => ({ sha, exists: true, onMain: false })
const missing = (sha: string): CommitStanding => ({ sha, exists: false, onMain: false })
const unknown = (sha: string): CommitStanding => ({ sha, exists: null, onMain: null })

/** Ancestry is a QUESTION ABOUT TODAY, so the fake answers it from a live set. */
function resolver(onMainShas: Set<string>, knownShas?: Set<string>): CommitResolver {
  return sha => ({
    sha,
    exists: (knownShas ?? onMainShas).has(sha),
    onMain: onMainShas.has(sha),
  })
}

describe('parsePromiseBlock', () => {
  it('reads every field of a well-formed block', () => {
    const text = card([
      '  agreed: 2026-08-21',
      '  conversation: werk-promise-ledger',
      '  session: 292e9fce-df36-4467-8bb9-e80f6d036a76',
      '  asked: "per card, WHICH COMMIT delivered it"',
      '  closes: [83bf55f0]',
    ])
    expect(parsePromiseBlock(text)).toEqual({
      agreed: '2026-08-21',
      conversation: 'werk-promise-ledger',
      session: '292e9fce-df36-4467-8bb9-e80f6d036a76',
      asked: 'per card, WHICH COMMIT delivered it',
      closes: ['83bf55f0'],
    })
  })

  it('is null for a card with no promise block, and for one with no front matter', () => {
    expect(parsePromiseBlock('---\ntitle: x\nstatus: open\n---\n\nbody\n')).toBeNull()
    expect(parsePromiseBlock('just a markdown file\n')).toBeNull()
  })

  it('is null when the front matter is never closed -- refuse to guess where it ends', () => {
    expect(parsePromiseBlock('---\ntitle: x\npromise:\n  closes: [abc1234]\n')).toBeNull()
  })

  it('stops at the next top-level key instead of swallowing it', () => {
    const text = card(['  agreed: 2026-08-21'], []).replace('---\n\nBody', 'test_cmd: bun test\n---\n\nBody')
    const p = parsePromiseBlock(text)
    expect(p?.agreed).toBe('2026-08-21')
    expect(p?.closes).toEqual([])
    expect(p?.asked).toBeNull()
  })

  it('reads a `>` folded ask as its TEXT, not as the block indicator', () => {
    const text = card([
      '  agreed: 2026-08-21',
      '  asked: >',
      '    each card must name',
      '    the commit that closed it',
    ])
    // `>` is non-empty, so returning the indicator would make isStub() report
    // this row as HAVING an ask -- blind to the commonest way of writing one.
    expect(parsePromiseBlock(text)?.asked).toBe('each card must name the commit that closed it')
    expect(isStub({ asked: parsePromiseBlock(text)?.asked ?? null })).toBe(false)
  })

  it('reads a `|` literal ask, blank lines and all', () => {
    const text = card(['  asked: |', '    first line', '', '    third line', '  closes: []'])
    expect(parsePromiseBlock(text)?.asked).toBe('first line\n\nthird line')
  })

  it('reads an empty `asked:` as null, which is what makes it a stub', () => {
    const text = card(['  agreed: 2026-08-21', '  asked: ""', '  closes: []'])
    const p = parsePromiseBlock(text)
    expect(p?.asked).toBeNull()
    expect(isStub(p ?? { asked: null })).toBe(true)
  })
})

describe('closes: -- all three shapes', () => {
  // Silently reading one shape as EMPTY reports a DELIVERED promise as never
  // started. This is the highest-value parse in the module.
  it('inline list', () => {
    expect(parsePromiseBlock(card(['  closes: [83bf55f0, 4b633b7d]']))?.closes).toEqual(['83bf55f0', '4b633b7d'])
  })

  it('bare single sha', () => {
    expect(parsePromiseBlock(card(['  closes: 83bf55f0']))?.closes).toEqual(['83bf55f0'])
  })

  it('`- ` list', () => {
    expect(parsePromiseBlock(card(['  closes:', '    - 83bf55f0', '    - 4b633b7d']))?.closes).toEqual([
      '83bf55f0',
      '4b633b7d',
    ])
  })

  it('empty inline list is not started, not malformed', () => {
    expect(parsePromiseBlock(card(['  closes: []']))?.closes).toEqual([])
  })

  it('a missing closes: key is the same as an empty one', () => {
    expect(parsePromiseBlock(card(['  agreed: 2026-08-21']))?.closes).toEqual([])
  })

  it('strips the trailing `# why` comment -- otherwise git is asked for the whole line', () => {
    const text = card(['  closes:', '    - 83bf55f0  # pure shaping + ONE shared parser', '    - 4b633b7d'])
    expect(parsePromiseBlock(text)?.closes).toEqual(['83bf55f0', '4b633b7d'])
  })

  it('reads PAST comment lines and blanks -- they are legal inside a YAML sequence', () => {
    const text = card([
      '  closes:',
      '    - 83bf55f0',
      '    # the three below landed together',
      '',
      '    - 4b633b7d',
      '    - c0ffee11',
    ])
    expect(parsePromiseBlock(text)?.closes).toEqual(['83bf55f0', '4b633b7d', 'c0ffee11'])
  })

  it('keeps a `#` that is inside a quoted value', () => {
    expect(parsePromiseBlock(card(['  closes: ["83bf55f0 # not a comment"]']))?.closes).toEqual([
      '83bf55f0 # not a comment',
    ])
  })

  it('a flattened block reads as NO promise at all, never as a half-read one', () => {
    // The 2026-08-11 shape: `promise:` survives as a null scalar, children at
    // column 0. Reporting a partial promise here would be a lie; the defect
    // detector is what surfaces it.
    const flat = ['---', 'title: x', 'status: open', 'promise: ""', 'agreed: 2026-08-21', 'closes: ""', '---', ''].join(
      '\n',
    )
    expect(parsePromiseBlock(flat)).toBeNull()
  })
})

describe('verdictFor -- five states, worst honest answer wins', () => {
  it('not-started when nothing is claimed', () => {
    expect(verdictFor([])).toBe('not-started')
  })

  it('delivered only when EVERY named commit is on main', () => {
    expect(verdictFor([on('a'), on('b')])).toBe('delivered')
    expect(verdictFor([on('a'), offMain('b')])).toBe('not-on-main')
  })

  it('commit-missing when a named commit does not resolve', () => {
    expect(verdictFor([on('a'), missing('b')])).toBe('commit-missing')
  })

  it('not-on-main when it exists but main does not contain it', () => {
    expect(verdictFor([offMain('a')])).toBe('not-on-main')
  })

  it('unverifiable is NEVER folded into the others', () => {
    // "I could not check" is not "it is fine", and it is not "it is broken".
    expect(verdictFor([unknown('a')])).toBe('unverifiable')
    expect(verdictFor([on('a'), unknown('b')])).toBe('unverifiable')
    expect(verdictFor([missing('a'), unknown('b')])).toBe('unverifiable')
    expect(verdictFor([{ sha: 'a', exists: true, onMain: null }])).toBe('unverifiable')
  })

  it('isOutstanding is everything but delivered', () => {
    expect(isOutstanding('delivered')).toBe(false)
    for (const v of ['not-started', 'commit-missing', 'not-on-main', 'unverifiable'] as const) {
      expect(isOutstanding(v)).toBe(true)
    }
  })
})

describe('a reverted promise re-opens itself', () => {
  it('flips delivered -> not-on-main with no edit to the card', () => {
    const text = card(['  agreed: 2026-08-21', '  asked: "ship it"', '  closes: [83bf55f0]'])
    const args = { id: 'werk-x', status: 'done', title: 'A promise', text }

    const yesterday = promiseFromCard(args, resolver(new Set(['83bf55f0'])))
    expect(yesterday?.verdict).toBe('delivered')

    // The revert takes the original off main's ancestor path. Same card, same
    // `closes:`, nobody had to remember to re-open anything.
    const today = promiseFromCard(args, resolver(new Set(), new Set(['83bf55f0'])))
    expect(today?.verdict).toBe('not-on-main')
    expect(today?.closes).toEqual(['83bf55f0'])
  })
})

describe('promiseFromCard / the loud tables', () => {
  const row = (over: Partial<PromiseRow>): PromiseRow => ({
    id: 'x',
    status: 'open',
    title: 'x',
    agreed: '2026-08-21',
    conversation: null,
    session: null,
    asked: 'something',
    closes: [],
    commits: [],
    verdict: 'not-started',
    ...over,
  })

  it('is null for a card carrying no promise', () => {
    expect(promiseFromCard({ id: 'x', status: 'open', title: 'x', text: card([]) }, resolver(new Set()))).toBeTruthy()
    const plain = '---\ntitle: x\nstatus: open\n---\n\nbody\n'
    expect(promiseFromCard({ id: 'x', status: 'open', title: 'x', text: plain }, resolver(new Set()))).toBeNull()
  })

  it('resolves each sha exactly once, in order', () => {
    const seen: string[] = []
    const spy: CommitResolver = sha => {
      seen.push(sha)
      return on(sha)
    }
    const text = card(['  closes: [aaa1111, bbb2222]'])
    const r = promiseFromCard({ id: 'x', status: 'done', title: 'x', text }, spy)
    expect(seen).toEqual(['aaa1111', 'bbb2222'])
    expect(r?.commits.map(c => c.sha)).toEqual(['aaa1111', 'bbb2222'])
  })

  it('closedWithoutCommit catches a run that marked its own homework', () => {
    const rows = [
      row({ id: 'clean', status: 'done', verdict: 'delivered' }),
      row({ id: 'bare', status: 'done', verdict: 'not-started' }),
      row({ id: 'reverted', status: 'archived', verdict: 'not-on-main' }),
      row({ id: 'still-open', status: 'open', verdict: 'not-started' }),
    ]
    expect(closedWithoutCommit(rows).map(r => r.id)).toEqual(['bare', 'reverted'])
  })

  it('stubs are orthogonal to the verdict -- a stub can be perfectly delivered', () => {
    const rows = [row({ id: 'no-ask', asked: null, verdict: 'delivered' }), row({ id: 'has-ask' })]
    expect(stubs(rows).map(r => r.id)).toEqual(['no-ask'])
    expect(isStub({ asked: '   ' })).toBe(true)
  })
})

describe('detectCardDefects -- reported, never repaired', () => {
  it('finds a promise block that sits BELOW the closing fence', () => {
    const text = [
      '---',
      'title: x',
      'status: open',
      '---',
      '',
      'Body.',
      '',
      'promise:',
      '  closes: [abc1234]',
      '',
    ].join('\n')
    expect(detectCardDefects(text)).toContain('promise-in-body')
    expect(parsePromiseBlock(text)).toBeNull()
  })

  it('finds a card with no status: key -- it cannot be placed, so it is invisible', () => {
    const text = ['---', 'title: x', 'promise:', '  closes: []', '---', ''].join('\n')
    expect(detectCardDefects(text)).toContain('missing-status')
  })

  it('finds a de-indented promise block by SHAPE', () => {
    const text = ['---', 'title: x', 'status: open', 'promise: ""', 'agreed: 2026-08-21', 'closes: ""', '---', ''].join(
      '\n',
    )
    expect(detectCardDefects(text)).toContain('promise-keys-at-top-level')
  })

  it('is silent on a healthy card', () => {
    expect(detectCardDefects(card(['  agreed: 2026-08-21', '  closes: []']))).toEqual([])
  })

  it("catches THIS repo's own card writer flattening a promise block", () => {
    // Not a hypothetical migration: `parseFrontmatter` is flat by design, so
    // every write through `serializeCard` (project_set_status included) reads a
    // promise block back as top-level keys and writes it out flattened, closes
    // emptied. Filed as werk-promise-ledger-card-writer-flattens; pinned here so
    // the day it is fixed, this test says so.
    const text = card(['  agreed: 2026-08-21', '  asked: "the ask"', '  closes:', '    - 83bf55f0'])
    const { meta, body } = parseFrontmatter(text)
    const round = serializeCard(meta, body)

    expect(detectCardDefects(round)).toContain('promise-keys-at-top-level')
    expect(parsePromiseBlock(round)).toBeNull()
    expect(parsePromiseBlock(text)?.closes).toEqual(['83bf55f0'])
  })
})

describe('insertPromiseBlock -- line surgery, never a re-serialisation', () => {
  const plain = ['---', 'title: "A card"', 'status: open', 'test_cmd: bun test', '---', '', 'Body.', ''].join('\n')

  it('splices the block in above the closing fence and touches nothing else', () => {
    const r = insertPromiseBlock(plain, { agreed: '2026-08-21', conversation: 'werk-run' })
    expect(r.refused).toBeNull()
    expect(r.changed).toBe(true)
    expect(r.text).toContain('test_cmd: bun test\npromise:\n  agreed: 2026-08-21\n')
    expect(r.text.endsWith('\n\nBody.\n')).toBe(true)
    expect(parsePromiseBlock(r.text)).toEqual({
      agreed: '2026-08-21',
      conversation: 'werk-run',
      session: null,
      asked: null,
      closes: [],
    })
  })

  it('scaffolds `asked:` EMPTY on purpose -- a plausible fake ask is worse than a blank', () => {
    const r = insertPromiseBlock(plain, { agreed: '2026-08-21' })
    expect(r.text).toContain('  asked: ""')
    expect(isStub(parsePromiseBlock(r.text) ?? { asked: null })).toBe(true)
  })

  it('quotes a value that would not survive the reader', () => {
    const lines = renderPromiseBlock({ agreed: '2026-08-21', asked: 'closes: nothing # yet' })
    expect(lines).toContain('  asked: "closes: nothing # yet"')
    const r = insertPromiseBlock(plain, { agreed: '2026-08-21', asked: 'closes: nothing # yet' })
    expect(parsePromiseBlock(r.text)?.asked).toBe('closes: nothing # yet')
  })

  it('is a no-op, NOT a refusal, when the card already has a block', () => {
    const already = card(['  agreed: 2026-01-01', '  closes: [abc1234]'])
    const r = insertPromiseBlock(already, { agreed: '2026-08-21' })
    expect(r).toEqual({ text: already, changed: false, refused: null })
  })

  it('REFUSES a card with no front matter rather than inventing one', () => {
    const r = insertPromiseBlock('just a markdown file\n', { agreed: '2026-08-21' })
    expect(r.changed).toBe(false)
    expect(r.text).toBe('just a markdown file\n')
    expect(r.refused).toBe('card has no front matter')
  })
})

describe('appendCloses', () => {
  it('creates the key when the block has no closes: yet', () => {
    const text = card(['  agreed: 2026-08-21'])
    const r = appendCloses(text, [{ sha: '83bf55f0', subject: 'feat: the thing' }])
    expect(r.refused).toBeNull()
    expect(r.added).toEqual(['83bf55f0'])
    expect(r.text).toContain('  closes:\n    - 83bf55f0  # feat: the thing')
    expect(parsePromiseBlock(r.text)?.closes).toEqual(['83bf55f0'])
  })

  it('rewrites an inline list to block form, carrying every existing sha', () => {
    const text = card(['  closes: [83bf55f0, 4b633b7d]'])
    const r = appendCloses(text, [{ sha: 'c0ffee11', subject: 'fix: the other thing' }])
    expect(parsePromiseBlock(r.text)?.closes).toEqual(['83bf55f0', '4b633b7d', 'c0ffee11'])
    expect(r.text).not.toContain('[83bf55f0')
  })

  it('appends after the LAST item of a block list, past comments and blanks', () => {
    const text = card(['  closes:', '    - 83bf55f0', '    # these two landed together', '    - 4b633b7d', ''])
    const r = appendCloses(text, [{ sha: 'c0ffee11' }])
    expect(parsePromiseBlock(r.text)?.closes).toEqual(['83bf55f0', '4b633b7d', 'c0ffee11'])
    // The comment stays ABOVE the item it explains; new shas land below both.
    const lines = r.text.split('\n')
    expect(lines.indexOf('    # these two landed together')).toBeLessThan(lines.indexOf('    - 4b633b7d'))
    expect(lines.indexOf('    - 4b633b7d')).toBeLessThan(lines.indexOf('    - c0ffee11'))
  })

  it('is idempotent, and matches a short sha against a full one', () => {
    const text = card(['  closes:', '    - 83bf55f0'])
    const full = '83bf55f0e4a1c9d2b7f3a5e6c8d9b0a1f2e3d4c5'
    const r = appendCloses(text, [{ sha: full, subject: 'same commit, 40 chars' }])
    expect(r.added).toEqual([])
    expect(r.skipped).toEqual([full])
    expect(r.changed).toBe(false)
    expect(r.text).toBe(text)
  })

  it('leaves the rest of the card byte-identical', () => {
    const text = card(['  agreed: 2026-08-21', '  asked: |', '    keep', '', '    this', '  closes: []'])
    const r = appendCloses(text, [{ sha: 'c0ffee11' }])
    expect(parsePromiseBlock(r.text)?.asked).toBe('keep\n\nthis')
    expect(r.text.startsWith('---\ntitle: "A promise"\nstatus: open\npromise:\n')).toBe(true)
    expect(r.text.endsWith('---\n\nBody text.\n')).toBe(true)
  })

  it('does not swallow the next top-level key', () => {
    const text = [
      '---',
      'title: x',
      'status: open',
      'promise:',
      '  agreed: 2026-08-21',
      'test_cmd: bun test',
      '---',
      '',
    ].join('\n')
    const r = appendCloses(text, [{ sha: 'c0ffee11' }])
    expect(r.text).toContain('  closes:\n    - c0ffee11\ntest_cmd: bun test')
    expect(parsePromiseBlock(r.text)?.closes).toEqual(['c0ffee11'])
  })

  it('flattens a multi-line subject and truncates a long one', () => {
    const text = card(['  closes: []'])
    const long = `feat: ${'x'.repeat(90)}`
    const r = appendCloses(text, [
      { sha: 'c0ffee11', subject: 'line one\nline two' },
      { sha: 'deadbee5', subject: long },
    ])
    expect(r.text).toContain('- c0ffee11  # line one line two')
    expect(r.text).toContain('...')
    expect(r.text.split('\n').every(l => l.length < 200)).toBe(true)
    expect(parsePromiseBlock(r.text)?.closes).toEqual(['c0ffee11', 'deadbee5'])
  })

  it('REFUSES with a reason rather than rewriting a card it cannot parse', () => {
    // Never a throw: a promise is bookkeeping, and a blocking chore produces
    // --skip-check. A board that cannot be written loses a card, never a merge.
    const noFm = 'just a markdown file\n'
    expect(appendCloses(noFm, [{ sha: 'c0ffee11' }])).toEqual({
      text: noFm,
      changed: false,
      added: [],
      skipped: [],
      refused: 'card has no front matter',
    })

    const noBlock = '---\ntitle: x\nstatus: open\n---\n\nbody\n'
    const r = appendCloses(noBlock, [{ sha: 'c0ffee11' }])
    expect(r.text).toBe(noBlock)
    expect(r.refused).toBe('card has no `promise:` block')
  })

  it('an empty commit list changes nothing and refuses nothing', () => {
    const text = card(['  closes: [83bf55f0]'])
    expect(appendCloses(text, [])).toEqual({ text, changed: false, added: [], skipped: [], refused: null })
  })

  it('de-duplicates within a single call', () => {
    const text = card(['  closes: []'])
    const r = appendCloses(text, [{ sha: 'c0ffee11' }, { sha: 'c0ffee11' }])
    expect(r.added).toEqual(['c0ffee11'])
    expect(parsePromiseBlock(r.text)?.closes).toEqual(['c0ffee11'])
  })
})
