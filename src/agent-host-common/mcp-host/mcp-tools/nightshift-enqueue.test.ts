/**
 * THE DEAD DOOR, closed. `action=enqueue` must land on the BOARD -- the only
 * place the night run looks -- and must refuse rather than answer `ok` when it
 * cannot. A successful-looking call that does nothing is the bug under test, so
 * every failing case here asserts BOTH the error and that nothing was written.
 *
 * Real files in a real temp root: the whole change is about which bytes land
 * where, and a mocked store would mock the bug away.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenDialogRegistry } from '../open-dialogs'
import { handleNightshiftEnqueue } from './nightshift-enqueue'
import type { McpToolContext } from './types'

let root: string
let projectChanged: number

function buildCtx(): McpToolContext {
  return {
    callbacks: {
      onProjectChanged: () => {
        projectChanged++
      },
    },
    getIdentity: () => null,
    getClaudeCodeVersion: () => '0.0.0',
    getDialogCwd: () => root,
    pendingDialogs: new Map(),
    openDialogs: new OpenDialogRegistry(),
    elog: () => {},
  }
}

const cardsDir = (): string => join(root, '.rclaude', 'project', 'cards')

function cardIds(): string[] {
  if (!existsSync(cardsDir())) return []
  return readdirSync(cardsDir())
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
    .sort()
}

function readCard(id: string): string {
  return readFileSync(join(cardsDir(), `${id}.md`), 'utf8')
}

function writeCard(id: string, frontmatter: string[], body = 'existing body'): void {
  mkdirSync(cardsDir(), { recursive: true })
  writeFileSync(join(cardsDir(), `${id}.md`), `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`, 'utf8')
}

function enqueue(params: Record<string, string>) {
  const res = handleNightshiftEnqueue(buildCtx(), { project: `claude://default${root}`, ...params })
  return { isError: !!res.isError, text: res.content[0].text }
}

function payload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ns-enqueue-'))
  projectChanged = 0
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('enqueue files a board card', () => {
  test('creates a card carrying #nightshift', () => {
    const res = enqueue({ title: 'Fix the flaky test' })
    expect(res.isError).toBe(false)

    const ids = cardIds()
    expect(ids).toEqual(['fix-the-flaky-test'])
    const card = readCard('fix-the-flaky-test')
    expect(card).toContain('title: Fix the flaky test')
    expect(card).toContain('tags: [nightshift]')

    const out = payload(res.text)
    expect(out.ok).toBe(true)
    expect(out.created).toBe(true)
    expect(out.id).toBe('fix-the-flaky-test')
    expect(out.card).toBe('.rclaude/project/cards/fix-the-flaky-test.md')
    expect(out.tag).toBe('nightshift')
  })

  test('folds description, acceptance, risk and feasibility into the body -- nothing is dropped', () => {
    enqueue({
      title: 'T',
      description: 'do the thing',
      acceptance: 'the thing is done',
      risk: 'medium',
      feasibility: 'uncertain',
    })
    const body = readCard('t')
    expect(body).toContain('do the thing')
    expect(body).toContain('## Acceptance\nthe thing is done')
    expect(body).toContain('_risk: medium -- feasibility: uncertain_')
  })

  test('notifies the host that the board changed', () => {
    enqueue({ title: 'T' })
    expect(projectChanged).toBe(1)
  })
})

describe('enqueue tags an existing card instead of copying it', () => {
  test('board_ref tags that card and files nothing new', () => {
    writeCard('known-card', ['title: Known', 'status: open', 'tags: [bug]'])
    const res = enqueue({ title: 'ignored when tagging', board_ref: 'known-card' })
    expect(res.isError).toBe(false)

    expect(cardIds()).toEqual(['known-card'])
    const card = readCard('known-card')
    expect(card).toContain('tags: [bug, nightshift]')
    expect(card).toContain('existing body')

    const out = payload(res.text)
    expect(out.created).toBe(false)
    expect(out.id).toBe('known-card')
  })

  test('tagging twice is a no-op, not a second entry', () => {
    writeCard('known-card', ['title: Known', 'status: open', 'tags: [nightshift]'])
    const res = enqueue({ title: 'T', board_ref: 'known-card' })
    expect(res.isError).toBe(false)
    expect(payload(res.text).alreadyTagged).toBe(true)
    expect(readCard('known-card')).toContain('tags: [nightshift]')
    expect(cardIds()).toEqual(['known-card'])
  })

  test('a board_ref that names nothing REFUSES -- it never files a lookalike card', () => {
    writeCard('other', ['title: Other', 'status: open'])
    const res = enqueue({ title: 'Some title', board_ref: 'ghost-card' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('ghost-card')
    expect(cardIds()).toEqual(['other'])
  })

  test('source=board without board_ref refuses rather than duplicating the card it means', () => {
    const res = enqueue({ title: 'T', source: 'board' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('board_ref')
    expect(cardIds()).toEqual([])
  })
})

describe('enqueue refuses instead of reporting a false success', () => {
  test('title is required', () => {
    const res = enqueue({})
    expect(res.isError).toBe(true)
    expect(res.text).toContain('title is required')
    expect(cardIds()).toEqual([])
  })

  test('project is required', () => {
    const res = handleNightshiftEnqueue(buildCtx(), { title: 'T' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('project')
  })

  test('a project root this host cannot see is refused, not half-written', () => {
    const missing = join(root, 'no', 'such', 'project')
    const res = handleNightshiftEnqueue(buildCtx(), { project: `claude://elsewhere${missing}`, title: 'T' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('not a directory on this host')
    expect(existsSync(missing)).toBe(false)
    expect(cardIds()).toEqual([])
  })

  test('a junk project URI is refused', () => {
    const res = handleNightshiftEnqueue(buildCtx(), { project: 'not-a-uri', title: 'T' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('cannot resolve a project root')
  })

  test('the URI names the board, not the calling conversation cwd', () => {
    // ctx.getDialogCwd() is `root`; the URI points somewhere else entirely.
    const other = mkdtempSync(join(tmpdir(), 'ns-other-'))
    try {
      handleNightshiftEnqueue(buildCtx(), { project: `claude://default${other}`, title: 'T' })
      expect(existsSync(join(other, '.rclaude', 'project', 'cards', 't.md'))).toBe(true)
      expect(cardIds()).toEqual([])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
