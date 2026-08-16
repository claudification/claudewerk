import { describe, expect, it, vi } from 'vitest'
import { ifNotTyping, nextFocus } from './use-batch-keys'

const key = (tagName?: string) =>
  ({ target: tagName ? { tagName } : null, preventDefault: vi.fn() }) as unknown as KeyboardEvent

describe('nextFocus', () => {
  const FOCUSABLE = [1, 2, 3, 5]

  it('steps to the next focusable row, skipping group headers', () => {
    expect(nextFocus(FOCUSABLE, 3, 1)).toBe(5)
  })

  it('steps backwards', () => {
    expect(nextFocus(FOCUSABLE, 5, -1)).toBe(3)
  })

  it('clamps at both ends instead of wrapping', () => {
    expect(nextFocus(FOCUSABLE, 5, 1)).toBe(5)
    expect(nextFocus(FOCUSABLE, 1, -1)).toBe(1)
  })

  it('lands on the first row when focus is currently on a header', () => {
    expect(nextFocus(FOCUSABLE, 0, 1)).toBe(1)
  })

  it('leaves focus alone when nothing is focusable', () => {
    expect(nextFocus([], 7, 1)).toBe(7)
  })
})

describe('ifNotTyping', () => {
  it('runs the handler for a keypress outside a field', () => {
    const run = vi.fn()
    const e = key()
    ifNotTyping(run)(e)
    expect(run).toHaveBeenCalled()
    expect(e.preventDefault).toHaveBeenCalled()
  })

  it('stands down while the user is typing', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const run = vi.fn()
      const e = key(tag)
      ifNotTyping(run)(e)
      expect(run).not.toHaveBeenCalled()
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
  })
})
