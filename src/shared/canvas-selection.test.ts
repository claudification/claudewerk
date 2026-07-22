/**
 * Selection summarization: what survives into the agent's context, and the
 * cap/degrade boundary that keeps a large selection from blowing up the prompt.
 */

import { expect, test } from 'bun:test'
import {
  type CanvasElementLike,
  describeSelection,
  MAX_DETAILED_ELEMENTS,
  MAX_TEXT_CHARS,
  summarizeSelection,
} from './canvas-selection'

function rect(id: string, extra: Partial<CanvasElementLike> = {}): CanvasElementLike {
  return {
    id,
    type: 'rectangle',
    x: 10.4,
    y: 20.6,
    width: 100,
    height: 50,
    strokeColor: '#1971c2',
    backgroundColor: 'transparent',
    ...extra,
  }
}

test('keeps the fields a request can refer to, drops the rest', () => {
  const sel = summarizeSelection([rect('a', { seed: 12345, versionNonce: 999 } as CanvasElementLike)], ['a'])

  expect(sel.count).toBe(1)
  expect(sel.truncated).toBe(false)
  expect(sel.elements[0]).toEqual({
    id: 'a',
    type: 'rectangle',
    text: undefined,
    strokeColor: '#1971c2',
    backgroundColor: 'transparent',
    // Rounded: sub-pixel precision is never part of "line these up".
    x: 10,
    y: 21,
    width: 100,
    height: 50,
  })
  // The noise fields must not ride along into the prompt.
  expect(JSON.stringify(sel)).not.toContain('versionNonce')
  expect(JSON.stringify(sel)).not.toContain('seed')
})

test('only the selected elements are included', () => {
  const sel = summarizeSelection([rect('a'), rect('b'), rect('c')], ['a', 'c'])
  expect(sel.elements.map(e => e.id)).toEqual(['a', 'c'])
})

test('a selected id that is not in the scene is ignored, not faked', () => {
  const sel = summarizeSelection([rect('a')], ['a', 'ghost'])
  expect(sel.count).toBe(1)
  expect(sel.elements.map(e => e.id)).toEqual(['a'])
})

test('deleted elements are excluded -- a tombstone is not selectable', () => {
  const sel = summarizeSelection([rect('a'), rect('b', { isDeleted: true })], ['a', 'b'])
  expect(sel.count).toBe(1)
  expect(sel.elements.map(e => e.id)).toEqual(['a'])
})

test('empty selection is a clean zero, not a degenerate listing', () => {
  expect(summarizeSelection([rect('a')], [])).toEqual({ count: 0, elements: [], truncated: false })
})

test('text is flattened and truncated', () => {
  const long = 'x'.repeat(MAX_TEXT_CHARS + 40)
  const sel = summarizeSelection(
    [rect('a', { type: 'text', text: `  multi\n  line   label  ` }), rect('b', { type: 'text', text: long })],
    ['a', 'b'],
  )
  expect(sel.elements[0].text).toBe('multi line label')
  expect(sel.elements[1].text).toBe(`${'x'.repeat(MAX_TEXT_CHARS)}...`)
  expect(sel.elements[1].text?.length).toBe(MAX_TEXT_CHARS + 3)
})

test('a label is used when there is no text', () => {
  const sel = summarizeSelection([rect('a', { label: 'Step one' })], ['a'])
  expect(sel.elements[0].text).toBe('Step one')
})

// ── the cap/degrade boundary ──────────────────────────────────────────

test('exactly MAX_DETAILED_ELEMENTS still lists every element', () => {
  const els = Array.from({ length: MAX_DETAILED_ELEMENTS }, (_, i) => rect(`e${i}`))
  const sel = summarizeSelection(
    els,
    els.map(e => String(e.id)),
  )
  expect(sel.truncated).toBe(false)
  expect(sel.elements).toHaveLength(MAX_DETAILED_ELEMENTS)
  expect(sel.histogram).toBeUndefined()
})

test('one past the cap degrades to a census, and the count stays TRUE', () => {
  const els = [
    ...Array.from({ length: MAX_DETAILED_ELEMENTS }, (_, i) => rect(`r${i}`)),
    rect('t0', { type: 'text', text: 'hi' }),
  ]
  const sel = summarizeSelection(
    els,
    els.map(e => String(e.id)),
  )

  expect(sel.truncated).toBe(true)
  // count reports the real selection size even though nothing is listed --
  // "42 selected" is the fact the model needs; 42 truncated rows are not.
  expect(sel.count).toBe(MAX_DETAILED_ELEMENTS + 1)
  expect(sel.elements).toHaveLength(0)
  expect(sel.histogram).toEqual({ rectangle: MAX_DETAILED_ELEMENTS, text: 1 })
})

// ── the UI chip ───────────────────────────────────────────────────────

test('describeSelection names a small selection and counts a big one', () => {
  expect(describeSelection(summarizeSelection([], []))).toBe('nothing selected')
  expect(describeSelection(summarizeSelection([rect('a', { text: 'Login' })], ['a']))).toBe('Login')
  expect(describeSelection(summarizeSelection([rect('a'), rect('b')], ['a', 'b']))).toBe('rectangle, rectangle')

  const many = Array.from({ length: 8 }, (_, i) => rect(`e${i}`))
  expect(
    describeSelection(
      summarizeSelection(
        many,
        many.map(e => String(e.id)),
      ),
    ),
  ).toBe('8 selected')
})
