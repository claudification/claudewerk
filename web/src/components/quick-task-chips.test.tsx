/**
 * The chip row is the ONLY evidence an eaten token produced metadata.
 *
 * `@epic-the-wall-ii` vanishes from the text on accept, so if these chips fail
 * to render the user is filing cards into an epic with nothing on screen saying
 * so. That makes "does the chip appear, and can it be taken back" the thing
 * worth guarding, not the styling.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { applyChip, emptyChips } from '@/lib/cards/task-chips'
import { QuickTaskChips } from './quick-task-chips'

afterEach(cleanup)

test('renders nothing at all when no token has been accepted', () => {
  const { container } = render(<QuickTaskChips chips={emptyChips()} onRemove={() => {}} />)
  expect(container.firstChild).toBeNull()
})

test('an accepted epic shows its id', () => {
  const chips = applyChip(emptyChips(), 'epic', 'epic-the-wall-ii')
  render(<QuickTaskChips chips={chips} onRemove={() => {}} />)
  expect(screen.getByText('epic-the-wall-ii')).toBeTruthy()
})

test('priority renders with its severity glyph', () => {
  const chips = applyChip(emptyChips(), 'priority', 'high')
  render(<QuickTaskChips chips={chips} onRemove={() => {}} />)
  expect(screen.getByText('!!! high')).toBeTruthy()
})

test('the two link kinds are labelled distinctly, not both as bare ids', () => {
  let chips = applyChip(emptyChips(), 'dependsOn', 'card-a')
  chips = applyChip(chips, 'relatesTo', 'card-b')
  render(<QuickTaskChips chips={chips} onRemove={() => {}} />)
  expect(screen.getByText('waits on card-a')).toBeTruthy()
  expect(screen.getByText('see card-b')).toBeTruthy()
})

test('every chip carries a removal control that reports its own kind and value', () => {
  const onRemove = vi.fn()
  let chips = applyChip(emptyChips(), 'epic', 'e1')
  chips = applyChip(chips, 'dependsOn', 'card-a')
  render(<QuickTaskChips chips={chips} onRemove={onRemove} />)

  fireEvent.click(screen.getByLabelText('Remove epic e1'))
  expect(onRemove).toHaveBeenCalledWith('epic', 'e1')

  fireEvent.click(screen.getByLabelText('Remove dependsOn card-a'))
  expect(onRemove).toHaveBeenCalledWith('dependsOn', 'card-a')
})

test('multiple list entries each get their own chip', () => {
  let chips = applyChip(emptyChips(), 'relatesTo', 'a')
  chips = applyChip(chips, 'relatesTo', 'b')
  render(<QuickTaskChips chips={chips} onRemove={() => {}} />)
  expect(screen.getByText('see a')).toBeTruthy()
  expect(screen.getByText('see b')).toBeTruthy()
})
