import { describe, expect, test } from 'bun:test'
import { cardWriteTarget, checkWrittenCard } from './project-card-hook'

const ROOT = '/Users/j/projects/thing'
const cardAt = (id: string) => `${ROOT}/.rclaude/project/cards/${id}.md`

const NOW = Date.parse('2026-08-21T12:00:00Z')

const io = (content: string | null, ids: string[] = []) => ({
  readFile: () => content,
  listIds: () => ids,
  now: () => NOW,
})

/** A board of real card files, keyed by id -- what the lifecycle checks need,
 *  because walking a `duplicate-of:` chain means reading the cards it passes. */
const boardIo = (cards: Record<string, string>) => ({
  readFile: (_root: string, id: string) => cards[id] ?? null,
  listIds: () => Object.keys(cards),
  now: () => NOW,
})

const card = (meta: string, body = 'body') => `---\n${meta}\n---\n\n${body}\n`

const checks = (findings: { check: string }[]) => findings.map(f => f.check)

describe('cardWriteTarget', () => {
  test('recognises a card write by every write tool', () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(cardWriteTarget(tool, cardAt('my-card'))).toEqual({ root: ROOT, id: 'my-card', canonical: true })
    }
  })

  test('ignores everything that is not a card write', () => {
    expect(cardWriteTarget('Read', cardAt('my-card'))).toBeNull()
    expect(cardWriteTarget('Bash', cardAt('my-card'))).toBeNull()
    expect(cardWriteTarget('Write', `${ROOT}/src/index.ts`)).toBeNull()
    expect(cardWriteTarget('Write', `${ROOT}/.rclaude/project/priority.md`)).toBeNull()
    expect(cardWriteTarget('Write', '')).toBeNull()
  })

  test('a write into a legacy lane folder is flagged as non-canonical', () => {
    const target = cardWriteTarget('Write', `${ROOT}/.rclaude/project/open/stray.md`)
    expect(target).toEqual({ root: ROOT, id: 'stray', canonical: false })
  })
})

describe('checkWrittenCard', () => {
  const target = { root: ROOT, id: 'my-card', canonical: true }

  test('a good card produces no noise at all', () => {
    const good = '---\ntitle: Good\nstatus: open\n---\n\nsome body\n'
    expect(checkWrittenCard(target, io(good))).toEqual([])
  })

  test('catches a mistyped lane -- the board would silently show it as inbox', () => {
    const bad = '---\ntitle: T\nstatus: in-progres\n---\n\nbody\n'
    expect(checks(checkWrittenCard(target, io(bad)))).toContain('card-status-invalid')
  })

  test('catches a missing lane', () => {
    expect(checks(checkWrittenCard(target, io('---\ntitle: T\n---\n\nbody\n')))).toContain('card-status-missing')
  })

  test('catches a link to a card that does not exist', () => {
    const card = '---\ntitle: T\nstatus: open\n---\n\nsee [x](.rclaude/project/cards/nope.md)\n'
    expect(checks(checkWrittenCard(target, io(card, ['my-card'])))).toContain('link-rot')
  })

  test('a link to a card that DOES exist is silent', () => {
    const card = '---\ntitle: T\nstatus: open\n---\n\nsee [x](.rclaude/project/cards/real.md)\n'
    expect(checkWrittenCard(target, io(card, ['my-card', 'real']))).toEqual([])
  })

  test('info-level findings are dropped -- a hook that cries wolf gets ignored', () => {
    // No title and an empty body are both info; neither should reach the agent.
    expect(checkWrittenCard(target, io('---\nstatus: open\n---\n\n'))).toEqual([])
  })

  test('a write outside cards/ is reported even when the card itself is fine', () => {
    const good = '---\ntitle: Good\nstatus: open\n---\n\nbody\n'
    const found = checkWrittenCard({ ...target, canonical: false }, io(good))
    expect(checks(found)).toEqual(['card-written-outside-cards'])
  })

  test('an unreadable card is reported, not swallowed', () => {
    expect(checks(checkWrittenCard(target, io(null)))).toContain('card-unreadable')
  })

  /**
   * DELIVERY, not the rule -- card-test-cmd.test.ts owns what counts as the bare
   * runner. What is pinned here is that the finding reaches the agent AT THE
   * WRITE, because every later moment (the sweep, the dispatch, the gate) is one
   * where nobody is watching, and that is the whole argument of the card.
   */
  describe('test_cmd', () => {
    test('a bare runner the repo hard-denies reaches the agent that just typed it', () => {
      const bad = card('title: T\nstatus: open\ntest_cmd: bun test src/shared && bun run typecheck')
      expect(checks(checkWrittenCard(target, io(bad, ['my-card'])))).toContain('card-test-cmd-denied')
    })

    test('the wrapper form passes silently', () => {
      const good = card('title: T\nstatus: open\ntest_cmd: bun run test src/shared && bun run typecheck')
      expect(checkWrittenCard(target, io(good, ['my-card']))).toEqual([])
    })

    test('it survives the info filter -- an error is never dropped as noise', () => {
      const bad = card('title: T\nstatus: open\ntest_cmd: bun test')
      const finding = checkWrittenCard(target, io(bad, ['my-card'])).find(f => f.check === 'card-test-cmd-denied')
      expect(finding?.severity).toBe('error')
    })
  })

  /**
   * The lifecycle keys reach the agent through this same path and no other --
   * that is the entire economics of the card that added them: one finding
   * function, zero new wiring. These tests pin the DELIVERY, not the rules
   * (project-doctor-lifecycle.test.ts owns those).
   */
  describe('the lifecycle keys', () => {
    test('a reason on a card that is not archived reaches the agent', () => {
      const bad = card('title: T\nstatus: open\narchived_reason: done\narchived_by: me')
      expect(checks(checkWrittenCard(target, io(bad, ['my-card'])))).toContain('lifecycle-reason-not-archived')
    })

    test('a duplicate-of pointing at a card this board does not have', () => {
      const bad = card('title: T\nstatus: archived\narchived_reason: duplicate-of:gone\narchived_by: me')
      expect(checks(checkWrittenCard(target, io(bad, ['my-card'])))).toContain('lifecycle-duplicate-missing')
    })

    test('a duplicate-of CYCLE, which needs the other cards read back off the board', () => {
      const found = checkWrittenCard(
        target,
        boardIo({
          'my-card': card('title: T\nstatus: archived\narchived_by: me\narchived_reason: duplicate-of:other'),
          other: card('title: O\nstatus: archived\narchived_by: me\narchived_reason: duplicate-of:my-card'),
        }),
      )
      expect(checks(found)).toContain('lifecycle-duplicate-cycle')
    })

    test('a delete_at already elapsed at the moment it is written', () => {
      const bad = card('title: T\nstatus: open\ndelete_at: 2020-01-01')
      expect(checks(checkWrittenCard(target, io(bad, ['my-card'])))).toContain('lifecycle-delete-at-past')
    })

    test('a garbage delete_at is caught ONCE, by the key registry that already owns dates', () => {
      const bad = card('title: T\nstatus: open\ndelete_at: soon')
      expect(checks(checkWrittenCard(target, io(bad, ['my-card'])))).toEqual(['card-key-type'])
    })

    test('a well-formed archived card is completely silent', () => {
      const found = checkWrittenCard(
        target,
        boardIo({
          'my-card': card(
            'title: T\nstatus: archived\ncreated: 2026-01-01\narchived_reason: duplicate-of:real\narchived_by: report-2026-08-22\ndelete_at: 2026-09-30',
          ),
          real: card('title: R\nstatus: open\ncreated: 2026-01-01'),
        }),
      )
      expect(found).toEqual([])
    })
  })

  test('every finding handed to an agent carries a remedy', () => {
    const bad = '---\nstatus: nope\n---\n\n[x](.rclaude/project/cards/gone.md)\n'
    const found = checkWrittenCard(target, io(bad))
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(f.remedy.length).toBeGreaterThan(0)
  })
})
