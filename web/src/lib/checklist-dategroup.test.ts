import { expect, test } from 'vitest'
import type { ChecklistItem } from '@shared/protocol'
import { groupByResolvedDate } from './checklist-dategroup'

const NOW = Date.parse('2026-06-16T12:00:00')

function done(text: string, resolvedAt: number): ChecklistItem {
  return { id: text, text, status: 'done', createdAt: 0, updatedAt: resolvedAt, resolvedAt }
}

test('buckets items by resolution day with relative labels', () => {
  const items = [
    done('a', Date.parse('2026-06-16T09:00:00')),
    done('b', Date.parse('2026-06-16T08:00:00')),
    done('c', Date.parse('2026-06-15T20:00:00')),
    done('d', Date.parse('2026-06-13T10:00:00')),
    done('e', Date.parse('2026-05-01T10:00:00')),
  ]
  const groups = groupByResolvedDate(items, NOW)
  expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday', '3 days ago', 'May 1, 2026'])
  expect(groups[0].items.map(i => i.text)).toEqual(['a', 'b'])
  expect(groups[2].items.map(i => i.text)).toEqual(['d'])
})

test('empty input -> no buckets', () => {
  expect(groupByResolvedDate([], NOW)).toEqual([])
})
