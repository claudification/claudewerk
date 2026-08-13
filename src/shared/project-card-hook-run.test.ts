import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCardWriteHook } from './project-card-hook-run'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'card-hook-run-'))
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeCard(id: string, body: string): string {
  const abs = join(root, '.rclaude', 'project', 'cards', `${id}.md`)
  writeFileSync(abs, body, 'utf8')
  return abs
}

const payload = (filePath: string, toolName = 'Write') =>
  JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } })

describe('runCardWriteHook', () => {
  test('a good card says nothing and exits 0', () => {
    const abs = writeCard('good', '---\ntitle: Good\nstatus: open\n---\n\nbody\n')
    expect(runCardWriteHook(payload(abs))).toEqual({ exitCode: 0, stderr: [] })
  })

  test('a bad lane exits 2 with the problem AND the remedy', () => {
    const abs = writeCard('bad', '---\ntitle: B\nstatus: opne\n---\n\nbody\n')
    const r = runCardWriteHook(payload(abs))
    expect(r.exitCode).toBe(2)
    const text = r.stderr.join('\n')
    expect(text).toContain('card-status-invalid')
    expect(text).toContain('set `status:` to one of')
  })

  test('a link to a card the board does not have is reported', () => {
    writeCard('other', '---\ntitle: O\nstatus: open\n---\n\nbody\n')
    const abs = writeCard('linker', '---\ntitle: L\nstatus: open\n---\n\n[x](.rclaude/project/cards/ghost.md)\n')
    const r = runCardWriteHook(payload(abs))
    expect(r.exitCode).toBe(2)
    expect(r.stderr.join('\n')).toContain('ghost')
  })

  test('a write that is not a card is ignored', () => {
    expect(runCardWriteHook(payload(join(root, 'src/index.ts')))).toEqual({ exitCode: 0, stderr: [] })
  })

  test('a non-write tool is ignored', () => {
    const abs = writeCard('bad', '---\nstatus: opne\n---\n\nbody\n')
    expect(runCardWriteHook(payload(abs, 'Read')).exitCode).toBe(0)
  })

  // FAIL OPEN: none of these may ever break a session.
  test('malformed and hostile payloads all fail open', () => {
    for (const raw of ['', '   ', 'not json', '{', 'null', '[]', '{"tool_name":123}', '{"tool_input":"nope"}']) {
      expect(runCardWriteHook(raw)).toEqual({ exitCode: 0, stderr: [] })
    }
  })

  test('a card path whose file vanished still fails open-ish -- reported, never thrown', () => {
    const abs = join(root, '.rclaude', 'project', 'cards', 'never-written.md')
    const r = runCardWriteHook(payload(abs))
    expect(r.exitCode).toBe(2)
    expect(r.stderr.join('\n')).toContain('card-unreadable')
  })
})
