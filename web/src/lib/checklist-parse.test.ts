import { expect, test } from 'vitest'
import { parseChecklistInput } from './checklist-parse'

test('single plain line -> one open item', () => {
  expect(parseChecklistInput('buy milk')).toEqual([{ text: 'buy milk', status: 'open' }])
})

test('multi-line paste -> one item per non-blank line', () => {
  const r = parseChecklistInput('first\n\nsecond\n   \nthird')
  expect(r.map(i => i.text)).toEqual(['first', 'second', 'third'])
  expect(r.every(i => i.status === 'open')).toBe(true)
})

test('markdown task list round-trips: [ ] open, [~] in_progress, [x]/[X] done', () => {
  const r = parseChecklistInput('- [ ] todo\n- [x] done\n* [X] also done\n- [~] wip\n+ [ ] plus')
  expect(r).toEqual([
    { text: 'todo', status: 'open' },
    { text: 'done', status: 'done' },
    { text: 'also done', status: 'done' },
    { text: 'wip', status: 'in_progress' },
    { text: 'plus', status: 'open' },
  ])
})

test('numbered and bullet markers are stripped, no marker stays plain', () => {
  const r = parseChecklistInput('1. ping Jonas\n2) and Bob\n- dash item\njust text')
  expect(r.map(i => i.text)).toEqual(['ping Jonas', 'and Bob', 'dash item', 'just text'])
  expect(r.every(i => i.status === 'open')).toBe(true)
})

test('inline markdown in the label is preserved raw', () => {
  const r = parseChecklistInput('- [ ] fix `parseFoo()` and **ship**')
  expect(r).toEqual([{ text: 'fix `parseFoo()` and **ship**', status: 'open' }])
})

test('a bare checkbox with no label is dropped', () => {
  expect(parseChecklistInput('- [ ]   ')).toEqual([])
})

test('empty input -> no items', () => {
  expect(parseChecklistInput('')).toEqual([])
  expect(parseChecklistInput('\n\n  \n')).toEqual([])
})
