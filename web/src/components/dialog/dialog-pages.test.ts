import { describe, expect, test } from 'vitest'
import { layoutPages, pagesWithChanges, resolvePageIndex } from './dialog-pages'
import type { DialogLayout } from './types'

const PAGES: DialogLayout['pages'] = [
  { label: 'Plan', body: [{ type: 'Markdown', id: 'a', content: 'x' }] },
  { label: 'Files', body: [{ type: 'Markdown', id: 'b', content: 'y' }] },
  {
    label: 'Risks',
    body: [{ type: 'Group', id: 'g', label: 'g', children: [{ type: 'Markdown', id: 'deep', content: 'z' }] }],
  },
]

describe('layoutPages', () => {
  test('wraps a single body as one unlabelled page', () => {
    const out = layoutPages({ title: 'T', body: [{ type: 'Markdown', id: 'a', content: 'x' }] })
    expect(out.length).toBe(1)
    expect(out[0].label).toBe('')
  })
  test('passes pages through', () => {
    expect(layoutPages({ title: 'T', pages: PAGES }).length).toBe(3)
  })
})

describe('resolvePageIndex', () => {
  test('clamps a numeric index into range', () => {
    expect(resolvePageIndex(1, PAGES)).toBe(1)
    expect(resolvePageIndex(99, PAGES)).toBe(2)
    expect(resolvePageIndex(-5, PAGES)).toBe(0)
  })
  test('matches a label exactly then case-insensitively', () => {
    expect(resolvePageIndex('Files', PAGES)).toBe(1)
    expect(resolvePageIndex('risks', PAGES)).toBe(2)
  })
  test('returns undefined for an unknown label or empty input', () => {
    expect(resolvePageIndex('Nope', PAGES)).toBeUndefined()
    expect(resolvePageIndex('', PAGES)).toBeUndefined()
    expect(resolvePageIndex(undefined, PAGES)).toBeUndefined()
  })
})

describe('pagesWithChanges', () => {
  test('flags pages holding a changed block, including nested', () => {
    expect(pagesWithChanges(PAGES, new Set(['b']))).toEqual([false, true, false])
    expect(pagesWithChanges(PAGES, new Set(['deep']))).toEqual([false, false, true])
  })
  test('all false when nothing changed', () => {
    expect(pagesWithChanges(PAGES, new Set())).toEqual([false, false, false])
  })
})
