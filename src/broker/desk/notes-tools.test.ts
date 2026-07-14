import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setUserNotesFile } from './notes'
import { notesTools } from './notes-tools'
import type { ToolContext } from './tool-def'

const ctx: ToolContext = {}

beforeEach(() => {
  setUserNotesFile(join(mkdtempSync(join(tmpdir(), 'notes-tools-')), 'user-notes.md'))
})
afterEach(() => {
  setUserNotesFile('')
})

describe('notesTools', () => {
  test('exposes exactly the five note tools', () => {
    const tools = notesTools(null)
    expect(Object.keys(tools).sort()).toEqual(
      ['append_notes', 'clear_notes', 'edit_notes', 'read_notes', 'write_notes'].sort(),
    )
  })

  test('take-my-notes flow: append then read back', async () => {
    const tools = notesTools('user_1')
    await tools.append_notes.execute({ text: 'ship the dispatcher notes feature' }, ctx)
    const out = (await tools.read_notes.execute({}, ctx)) as { notes: string }
    expect(out.notes).toContain('ship the dispatcher notes feature')
  })

  test('read_notes carries a note when empty', async () => {
    const tools = notesTools(null)
    const out = (await tools.read_notes.execute({}, ctx)) as { notes: string; note?: string }
    expect(out.notes).toBe('')
    expect(out.note).toContain('no notes saved yet')
  })

  test('edit_notes returns a structured failure on ambiguity (no write)', async () => {
    const tools = notesTools(null)
    await tools.write_notes.execute({ content: 'dup\ndup' }, ctx)
    const out = (await tools.edit_notes.execute({ oldString: 'dup', newString: 'x', replaceAll: null }, ctx)) as {
      ok: boolean
      error?: string
    }
    expect(out.ok).toBe(false)
    expect(out.error).toContain('2 times')
    const after = (await tools.read_notes.execute({}, ctx)) as { notes: string }
    expect(after.notes).toBe('dup\ndup\n')
  })

  test('edit_notes replaceAll works through the tool', async () => {
    const tools = notesTools(null)
    await tools.write_notes.execute({ content: 'foo then foo' }, ctx)
    const out = (await tools.edit_notes.execute({ oldString: 'foo', newString: 'bar', replaceAll: true }, ctx)) as {
      ok: boolean
      replaced?: number
    }
    expect(out).toMatchObject({ ok: true, replaced: 2 })
  })

  test('clear_notes wipes everything', async () => {
    const tools = notesTools(null)
    await tools.append_notes.execute({ text: 'something' }, ctx)
    expect(await tools.clear_notes.execute({}, ctx)).toEqual({ cleared: true })
    const out = (await tools.read_notes.execute({}, ctx)) as { notes: string }
    expect(out.notes).toBe('')
  })
})
