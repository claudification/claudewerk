import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeChecklistStore,
  createItems,
  deleteItem,
  initChecklistStore,
  listArchive,
  listOpen,
  purgeResolved,
  toggleItem,
  updateText,
} from './checklist-store'

const P = 'claude://default/Users/x/proj'
const Q = 'claude://default/Users/x/other'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checklist-test-'))
  initChecklistStore(dir)
})

afterEach(() => {
  closeChecklistStore()
  rmSync(dir, { recursive: true, force: true })
})

test('create + listOpen: open items, oldest first, blanks skipped', () => {
  const n = createItems(P, [{ text: 'first' }, { text: '   ' }, { text: 'second' }])
  expect(n).toBe(2)
  const open = listOpen(P)
  expect(open.map(i => i.text)).toEqual(['first', 'second'])
  expect(open[0].resolvedAt).toBeNull()
})

test('create with resolved=true lands in archive, not open', () => {
  createItems(P, [{ text: 'done already', resolved: true }, { text: 'todo' }])
  expect(listOpen(P).map(i => i.text)).toEqual(['todo'])
  const arch = listArchive(P)
  expect(arch.map(i => i.text)).toEqual(['done already'])
  expect(arch[0].resolvedAt).toBeGreaterThan(0)
})

test('toggle resolves then re-opens', () => {
  createItems(P, [{ text: 'task' }])
  const id = listOpen(P)[0].id
  toggleItem(P, id, true)
  expect(listOpen(P)).toHaveLength(0)
  expect(listArchive(P)).toHaveLength(1)
  toggleItem(P, id, false)
  expect(listOpen(P)).toHaveLength(1)
  expect(listArchive(P)).toHaveLength(0)
})

test('updateText edits raw text', () => {
  createItems(P, [{ text: 'old' }])
  const id = listOpen(P)[0].id
  updateText(P, id, '  new  ')
  expect(listOpen(P)[0].text).toBe('new')
})

test('delete removes an item', () => {
  createItems(P, [{ text: 'gone' }])
  const id = listOpen(P)[0].id
  deleteItem(P, id)
  expect(listOpen(P)).toHaveLength(0)
})

test('project scoping is isolated', () => {
  createItems(P, [{ text: 'mine' }])
  createItems(Q, [{ text: 'theirs' }])
  expect(listOpen(P).map(i => i.text)).toEqual(['mine'])
  expect(listOpen(Q).map(i => i.text)).toEqual(['theirs'])
})

test('mutations are scoped: wrong project cannot touch an item', () => {
  createItems(P, [{ text: 'protected' }])
  const id = listOpen(P)[0].id
  toggleItem(Q, id, true)
  deleteItem(Q, id)
  updateText(Q, id, 'hacked')
  const open = listOpen(P)
  expect(open).toHaveLength(1)
  expect(open[0].text).toBe('protected')
})

test('purgeResolved deletes only old resolved items', () => {
  createItems(P, [{ text: 'open one' }, { text: 'recent done', resolved: true }])
  // An item resolved "long ago": create open, then backdate via toggle is now-stamped,
  // so instead assert recent resolved survives a 30d purge and nothing open is touched.
  const purged = purgeResolved(P, Date.now() - 30 * 24 * 60 * 60 * 1000)
  expect(purged).toBe(0)
  expect(listOpen(P)).toHaveLength(1)
  expect(listArchive(P)).toHaveLength(1)
  // Purge everything resolved before "now + 1s" -> the recent one goes.
  const purged2 = purgeResolved(P, Date.now() + 1000)
  expect(purged2).toBe(1)
  expect(listArchive(P)).toHaveLength(0)
  expect(listOpen(P)).toHaveLength(1)
})
