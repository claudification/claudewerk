import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendNotes, clearNotes, editNotes, readNotes, setUserNotesFile, writeNotes } from './notes'

let notesFile = ''

beforeEach(() => {
  notesFile = join(mkdtempSync(join(tmpdir(), 'user-notes-')), 'user-notes.md')
  setUserNotesFile(notesFile)
})
afterEach(() => {
  setUserNotesFile('') // reset
})

describe('readNotes / appendNotes', () => {
  it('starts empty and appends verbatim blocks', () => {
    expect(readNotes()).toBe('')
    expect(appendNotes('buy milk')).toEqual({ appended: true, length: 'buy milk\n'.length })
    appendNotes('call the plumber')
    const notes = readNotes()
    expect(notes).toContain('buy milk')
    expect(notes).toContain('call the plumber')
    // blocks separated by a blank line
    expect(notes).toBe('buy milk\n\ncall the plumber\n')
  })

  it('ignores blank appends', () => {
    appendNotes('   \n  ')
    expect(readNotes()).toBe('')
  })
})

describe('writeNotes', () => {
  it('overwrites wholesale and ensures a trailing newline', () => {
    appendNotes('old note')
    writeNotes('brand new content')
    expect(readNotes()).toBe('brand new content\n')
  })

  it('snapshots the prior content before overwriting', () => {
    appendNotes('precious note')
    writeNotes('replacement')
    const versions = join(dirname(notesFile), 'user-notes-versions')
    expect(existsSync(versions)).toBe(true)
    expect(readdirSync(versions).length).toBe(1)
  })
})

describe('editNotes', () => {
  beforeEach(() => {
    writeNotes('alpha\nbravo\nalpha tail\n')
  })

  it('replaces a unique occurrence', () => {
    const r = editNotes('bravo', 'BRAVO')
    expect(r).toEqual({ ok: true, replaced: 1 })
    expect(readNotes()).toContain('BRAVO')
  })

  it('rejects an ambiguous edit unless replaceAll', () => {
    const r = editNotes('alpha', 'A')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('2 times')
    // file untouched on rejection
    expect(readNotes()).toBe('alpha\nbravo\nalpha tail\n')
  })

  it('replaces all when asked', () => {
    const r = editNotes('alpha', 'A', true)
    expect(r).toEqual({ ok: true, replaced: 2 })
    expect(readNotes()).toBe('A\nbravo\nA tail\n')
  })

  it('rejects a missing oldString', () => {
    const r = editNotes('zeta', 'Z')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('not found')
  })

  it('rejects a no-op edit', () => {
    const r = editNotes('bravo', 'bravo')
    expect(r.ok).toBe(false)
  })

  it('deletes matched text with an empty newString', () => {
    editNotes('bravo\n', '')
    expect(readNotes()).toBe('alpha\nalpha tail\n')
  })
})

describe('clearNotes', () => {
  it('empties the file and snapshots it, then no-ops on an empty file', () => {
    appendNotes('to be wiped')
    expect(clearNotes()).toEqual({ cleared: true })
    expect(readNotes()).toBe('')
    const versions = join(dirname(notesFile), 'user-notes-versions')
    expect(readdirSync(versions).length).toBe(1)
    // second clear is a no-op (nothing to back up)
    expect(clearNotes()).toEqual({ cleared: false })
    expect(readdirSync(versions).length).toBe(1)
  })
})

describe('uninitialized store', () => {
  it('degrades to no-ops when no file is set', () => {
    setUserNotesFile('')
    expect(readNotes()).toBe('')
    expect(appendNotes('x')).toEqual({ appended: false, length: 0 })
    expect(editNotes('a', 'b').ok).toBe(false)
    expect(clearNotes()).toEqual({ cleared: false })
  })
})
