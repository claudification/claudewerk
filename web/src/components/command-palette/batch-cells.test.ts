/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { Conversation } from '@/lib/types'
import { columnCount, hostLabel, recapSnippet } from './batch-cells'

const conv = (over: Partial<Conversation> = {}): Conversation => ({ id: 'c1', ...over }) as Conversation

describe('columnCount', () => {
  // REGRESSION: the count was hardcoded as `3 + optionals`, one short of the four
  // base columns (select/title/status/last). Group headers and the empty-state row
  // use it as colSpan, so their band stopped before the right edge of the table.
  it('counts the four base columns', () => {
    expect(columnCount({ project: false, host: false, recap: false })).toBe(4)
  })

  it('adds one per optional column', () => {
    expect(columnCount({ project: true, host: false, recap: false })).toBe(5)
    expect(columnCount({ project: false, host: true, recap: true })).toBe(6)
    expect(columnCount({ project: true, host: true, recap: true })).toBe(7)
  })
})

describe('hostLabel', () => {
  it('joins sentinel and profile', () => {
    expect(hostLabel(conv({ hostSentinelAlias: 'studio', resolvedProfile: 'work' }))).toBe('studio/work')
  })

  it('drops a "default" profile', () => {
    expect(hostLabel(conv({ hostSentinelAlias: 'studio', resolvedProfile: 'default' }))).toBe('studio')
  })

  it('falls back to the sentinel id when there is no alias', () => {
    expect(hostLabel(conv({ hostSentinelId: 'snt_abc' }))).toBe('snt_abc')
  })

  it('is null on the implicit default so the column can hide', () => {
    expect(hostLabel(conv())).toBeNull()
  })
})

describe('recapSnippet', () => {
  it('takes the first non-blank line', () => {
    expect(recapSnippet(conv({ recap: { content: '\n\n  Fixed the thing.\nmore' } } as Partial<Conversation>))).toBe(
      'Fixed the thing.',
    )
  })

  it('is null with no recap', () => {
    expect(recapSnippet(conv())).toBeNull()
  })
})
