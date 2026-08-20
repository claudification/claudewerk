/**
 * The board half of A8: pinning is a TOGGLE that reads back as STATE.
 *
 * The failure this guards is a button that looks like it worked and wrote
 * nothing -- the write is the whole feature, since the wall reads the card and
 * nothing else.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { EpicPinButton } from './epic-pin-button'

const sendBoardOp = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
vi.mock('@/hooks/use-project-tasks', () => ({ sendBoardOp }))

const PROJECT = 'claude:///Users/j/remote-claude'

function rollup(wallPinned?: boolean): EpicRollup {
  return {
    epicId: 'epic-the-wall',
    card: {
      slug: 'epic-the-wall',
      status: 'open',
      title: 'THE WALL',
      tags: ['epic'],
      refs: [],
      created: '',
      mtime: 1,
      bodyPreview: '',
      wallPinned,
    },
    children: [],
    notStarted: 0,
    inProgress: 0,
    done: 0,
    dropped: 0,
    total: 0,
    pct: null,
    complete: false,
  }
}

beforeEach(() => {
  sendBoardOp.mockClear()
  useConversationsStore.setState({
    selectedConversationId: 'c1',
    conversationsById: { c1: { id: 'c1', project: PROJECT } as Conversation },
  })
})
afterEach(cleanup)

describe('the pin-to-wall toggle', () => {
  it('writes the pin onto the epic card and reads back as state', async () => {
    render(<EpicPinButton rollup={rollup()} />)
    const button = screen.getByRole('button')

    expect(button.textContent).toBe('PIN')
    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)

    expect(sendBoardOp).toHaveBeenCalledWith(PROJECT, 'update', {
      slug: 'epic-the-wall',
      patch: { wallPinned: true },
    })
    await waitFor(() => expect(button.textContent).toBe('PINNED'))
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('a card that already carries the pin renders as PINNED, and unpins', () => {
    render(<EpicPinButton rollup={rollup(true)} />)
    const button = screen.getByRole('button')

    expect(button.textContent).toBe('PINNED')
    fireEvent.click(button)

    expect(sendBoardOp).toHaveBeenCalledWith(PROJECT, 'update', {
      slug: 'epic-the-wall',
      patch: { wallPinned: false },
    })
  })

  /**
   * THE 2026-08-20 SILENCE. The installed sentinel bundle predated A8 entirely
   * -- no `wall_pinned`, no `pinned` op -- so it accepted the `update`, dropped
   * the key, and answered ok. The button showed PINNED over a card with nothing
   * written on it, and the wall showed nothing, forever.
   */
  it('rolls back an OK reply whose card did not actually take the pin', async () => {
    sendBoardOp.mockResolvedValueOnce({ ok: true, task: { slug: 'epic-the-wall' } } as never)
    render(<EpicPinButton rollup={rollup()} />)
    const button = screen.getByRole('button')

    fireEvent.click(button)

    await waitFor(() => expect(button.textContent).toBe('PIN'))
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('accepts an OK reply whose card DID take the pin', async () => {
    sendBoardOp.mockResolvedValueOnce({ ok: true, task: { slug: 'epic-the-wall', wallPinned: true } } as never)
    render(<EpicPinButton rollup={rollup()} />)
    const button = screen.getByRole('button')

    fireEvent.click(button)

    await waitFor(() => expect(button.textContent).toBe('PINNED'))
  })

  /** Unpinning DELETES the key, so an unpinned card comes back with no
   *  `wallPinned` at all -- that is success, not a dropped write. */
  it('reads a missing key as a successful UNPIN', async () => {
    sendBoardOp.mockResolvedValueOnce({ ok: true, task: { slug: 'epic-the-wall' } } as never)
    render(<EpicPinButton rollup={rollup(true)} />)
    const button = screen.getByRole('button')

    fireEvent.click(button)

    await waitFor(() => expect(button.textContent).toBe('PIN'))
  })

  it('rolls the label back when the write FAILS, instead of lying about the card', async () => {
    sendBoardOp.mockResolvedValueOnce({ ok: false } as never)
    render(<EpicPinButton rollup={rollup()} />)
    const button = screen.getByRole('button')

    fireEvent.click(button)
    await waitFor(() => expect(button.textContent).toBe('PIN'))
  })

  it('is disabled for an epic with no card of its own -- there is nothing to write onto', () => {
    render(<EpicPinButton rollup={{ ...rollup(), card: null }} />)

    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button'))
    expect(sendBoardOp).not.toHaveBeenCalled()
  })

  /**
   * A DEAD BUTTON SAYS SO IN INK, not in a `title`. The old one rendered `PIN`
   * and hid its deadness in a hover, which does not exist on a tablet -- so a
   * click that could never work was indistinguishable from a pin that did not
   * persist, which is exactly what got reported on 2026-08-20.
   */
  it('names its own deadness on the face of the button, not only in the tooltip', () => {
    render(<EpicPinButton rollup={{ ...rollup(), card: null }} />)

    expect(screen.getByRole('button').textContent).toBe('NO CARD')
  })
})
