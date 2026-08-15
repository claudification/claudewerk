import { describe, expect, it } from 'bun:test'
import { BODY_PREVIEW_LIMIT, makeBodyPreview } from './body-preview'

describe('makeBodyPreview', () => {
  it('drops ATX heading markers', () => {
    // Straight off the board: cards opened with "## Symptom The EPICS view..."
    expect(makeBodyPreview('## Symptom\nThe EPICS view shows every epic as childless.')).toBe(
      'Symptom The EPICS view shows every epic as childless.',
    )
  })

  it('unwraps bold and italic', () => {
    expect(makeBodyPreview('the **spawn request shape** is *duplicated*')).toBe('the spawn request shape is duplicated')
  })

  it('unwraps intra-word emphasis', () => {
    // "**A**gent-**N**ative **V**isual" rendered with every asterisk visible.
    expect(makeBodyPreview('**A**gent-**N**ative **V**isual')).toBe('Agent-Native Visual')
  })

  it('unwraps underscore emphasis', () => {
    expect(makeBodyPreview('__bold__ and _italic_')).toBe('bold and italic')
  })

  it('keeps link text and drops the target', () => {
    expect(makeBodyPreview('see [REFACTOR-PLAN.md](../../../REFACTOR-PLAN.md) in the repo')).toBe(
      'see REFACTOR-PLAN.md in the repo',
    )
  })

  it('drops images entirely', () => {
    expect(makeBodyPreview('before ![a diagram](x.png) after')).toBe('before after')
  })

  it('keeps inline code content without the backticks', () => {
    expect(makeBodyPreview('put `epic: <id>` on the child')).toBe('put epic: <id> on the child')
  })

  it('drops fenced code blocks whole', () => {
    expect(makeBodyPreview('before\n```ts\nconst x = 1\n```\nafter')).toBe('before after')
  })

  it('drops blockquote and list markers', () => {
    expect(makeBodyPreview('> quoted\n- one\n* two\n1. three')).toBe('quoted one two three')
  })

  it('drops horizontal rules', () => {
    expect(makeBodyPreview('above\n---\nbelow')).toBe('above below')
  })

  it('collapses whitespace and blank lines', () => {
    expect(makeBodyPreview('a\n\n\n   b \n c')).toBe('a b c')
  })

  it('truncates at the limit', () => {
    const long = 'x'.repeat(BODY_PREVIEW_LIMIT + 200)
    expect(makeBodyPreview(long).length).toBeLessThanOrEqual(BODY_PREVIEW_LIMIT)
  })

  it('is total on empty and whitespace input', () => {
    expect(makeBodyPreview('')).toBe('')
    expect(makeBodyPreview('\n\n  \n')).toBe('')
  })

  it('leaves ordinary prose untouched', () => {
    expect(makeBodyPreview('A standing home for making conversations cheap.')).toBe(
      'A standing home for making conversations cheap.',
    )
  })

  it('does not eat a bare asterisk or underscore', () => {
    expect(makeBodyPreview('2 * 3 and snake_case_name')).toBe('2 * 3 and snake_case_name')
  })
})
