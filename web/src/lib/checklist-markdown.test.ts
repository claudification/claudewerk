import type { ChecklistItem } from '@shared/protocol'
import { expect, test } from 'vitest'
import { itemsToMarkdown, markdownToItems } from './checklist-markdown'

function item(p: Partial<ChecklistItem> & { text: string }): ChecklistItem {
  return { id: 'x', status: 'open', createdAt: 0, updatedAt: 0, resolvedAt: null, ...p }
}

test('itemsToMarkdown renders active boxes + a Completed section with dates', () => {
  const md = itemsToMarkdown(
    [item({ text: 'open one' }), item({ text: 'wip', status: 'in_progress' })],
    [item({ text: 'finished', status: 'done', resolvedAt: Date.parse('2026-06-15') })],
  )
  expect(md).toBe('- [ ] open one\n- [~] wip\n\n# Completed\n- [x] finished (done 2026-06-15)\n')
})

test('markdownToItems ignores headers + blanks, reads statuses', () => {
  const items = markdownToItems('- [ ] a\n- [~] b\n\n# Completed\n- [x] c (done 2026-06-15)\n')
  expect(items).toEqual([
    { text: 'a', status: 'open', resolvedAt: undefined },
    { text: 'b', status: 'in_progress', resolvedAt: undefined },
    { text: 'c', status: 'done', resolvedAt: Date.parse('2026-06-15') },
  ])
})

test('round-trips active + done losslessly (text + status + done date)', () => {
  const active = [item({ text: 'keep open' }), item({ text: 'mid', status: 'in_progress' })]
  const done = [item({ text: 'old', status: 'done', resolvedAt: Date.parse('2026-01-02') })]
  const back = markdownToItems(itemsToMarkdown(active, done))
  expect(back.map(i => [i.text, i.status])).toEqual([
    ['keep open', 'open'],
    ['mid', 'in_progress'],
    ['old', 'done'],
  ])
  expect(back[2].resolvedAt).toBe(Date.parse('2026-01-02'))
})

test('a done line with no date parses (best-effort, resolvedAt undefined)', () => {
  const items = markdownToItems('- [x] no date here')
  expect(items).toEqual([{ text: 'no date here', status: 'done', resolvedAt: undefined }])
})

test('plain prose line becomes an open item; # line is dropped', () => {
  const items = markdownToItems('# a header\njust a thought\n- [ ] real task')
  expect(items).toEqual([
    { text: 'just a thought', status: 'open', resolvedAt: undefined },
    { text: 'real task', status: 'open', resolvedAt: undefined },
  ])
})
