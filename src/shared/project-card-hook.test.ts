import { describe, expect, test } from 'bun:test'
import { cardWriteTarget, checkWrittenCard } from './project-card-hook'

const ROOT = '/Users/j/projects/thing'
const cardAt = (id: string) => `${ROOT}/.rclaude/project/cards/${id}.md`

const io = (content: string | null, ids: string[] = []) => ({
  readFile: () => content,
  listIds: () => ids,
})

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

  test('every finding handed to an agent carries a remedy', () => {
    const bad = '---\nstatus: nope\n---\n\n[x](.rclaude/project/cards/gone.md)\n'
    const found = checkWrittenCard(target, io(bad))
    expect(found.length).toBeGreaterThan(0)
    for (const f of found) expect(f.remedy.length).toBeGreaterThan(0)
  })
})
