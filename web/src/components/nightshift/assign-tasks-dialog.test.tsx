/**
 * THE OTHER DOOR. Two things could put work into nightshift: the board card's
 * Nightshift button, and this hand-typed form. The button now tags a card; if
 * this form had kept calling the `enqueue` op it would have been a door into a
 * room the engine no longer enters -- it would report success and the task
 * would never run, which is the exact failure the copy-queue was retired for.
 *
 * So it files a real CARD carrying `#nightshift`. Asserted here because "we did
 * not silently leave a second door open" is a claim, and a claim wants a test.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

type BoardCall = [projectUri: string, op: string, params: { input: { title: string; body: string; tags: string[] } }]
const sendBoardOp = vi.fn(async (..._args: BoardCall) => ({ ok: true }))
vi.mock('@/hooks/project-task-wire', () => ({ sendBoardOp: (...args: BoardCall) => sendBoardOp(...args) }))

afterEach(() => {
  cleanup()
  sendBoardOp.mockClear()
})

async function open() {
  const { AssignTasksDialog } = await import('./assign-tasks-dialog')
  render(<AssignTasksDialog projectUri="claude://s/p" open onOpenChange={vi.fn()} />)
}

test('a hand-typed task becomes a #nightshift card on the board, not a queue entry', async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Rebuild the index' } })
  fireEvent.change(screen.getByLabelText('Task description'), { target: { value: 'It is quadratic.' } })
  fireEvent.click(screen.getByRole('button', { name: /assign/i }))

  await waitFor(() => expect(sendBoardOp).toHaveBeenCalledTimes(1))
  expect(sendBoardOp).toHaveBeenCalledWith('claude://s/p', 'create', {
    input: { title: 'Rebuild the index', body: 'It is quadratic.', tags: ['nightshift'] },
  })
})

test('acceptance and the two qualifiers are written into the body, never dropped', async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Rebuild the index' } })
  fireEvent.change(screen.getByLabelText('Acceptance criteria'), { target: { value: 'p99 under 50ms' } })
  fireEvent.change(screen.getByLabelText('Task description'), { target: { value: 'It is quadratic.' } })
  fireEvent.click(screen.getByRole('button', { name: /assign/i }))

  await waitFor(() => expect(sendBoardOp).toHaveBeenCalledTimes(1))
  const body = sendBoardOp.mock.calls[0]?.[2].input.body ?? ''
  expect(body).toContain('It is quadratic.')
  expect(body).toContain('## Acceptance\np99 under 50ms')
})
