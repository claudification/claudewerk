/**
 * The picker is the only thing standing between the user and 800 dead
 * conversations, so its two guarantees get a rendered test: the search box
 * actually narrows the list, and every row carries its status.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChatCandidate } from './canvas-chat-candidates'
import { ConnectPicker } from './canvas-chat-connect-picker'
import type { CanvasChat } from './use-canvas-chat'

const CANDIDATES: ChatCandidate[] = [
  { id: 'a', name: 'nuclear-pelican', status: 'active' },
  { id: 'b', name: 'volatile-nugget', status: 'idle' },
  { id: 'c', name: 'shady-orca', status: 'booting' },
]

function chatWith(candidates: ChatCandidate[], connect = vi.fn()): CanvasChat {
  return {
    candidates,
    connectedId: null,
    connectedName: null,
    lines: [],
    error: null,
    connect,
    send: vi.fn(),
  }
}

afterEach(cleanup)

describe('ConnectPicker', () => {
  test('lists every live candidate with its status', () => {
    render(<ConnectPicker chat={chatWith(CANDIDATES)} />)
    expect(screen.getByTitle('nuclear-pelican -- active')).toBeTruthy()
    expect(screen.getByTitle('volatile-nugget -- idle')).toBeTruthy()
    expect(screen.getByTitle('shady-orca -- booting')).toBeTruthy()
  })

  test('search narrows the list', () => {
    render(<ConnectPicker chat={chatWith(CANDIDATES)} />)
    fireEvent.change(screen.getByLabelText('Search live conversations'), { target: { value: 'orca' } })
    expect(screen.queryByText('shady-orca')).toBeTruthy()
    expect(screen.queryByText('nuclear-pelican')).toBeNull()
  })

  test('a query that matches nothing says so instead of going blank', () => {
    render(<ConnectPicker chat={chatWith(CANDIDATES)} />)
    fireEvent.change(screen.getByLabelText('Search live conversations'), { target: { value: 'zzz' } })
    expect(screen.getByText(/Nothing matches/)).toBeTruthy()
  })

  test('picking a row connects that conversation', () => {
    const connect = vi.fn()
    render(<ConnectPicker chat={chatWith(CANDIDATES, connect)} />)
    fireEvent.click(screen.getByText('volatile-nugget'))
    expect(connect).toHaveBeenCalledWith('b')
  })

  test('no live conversations says so, with no search box to tease', () => {
    render(<ConnectPicker chat={chatWith([])} />)
    expect(screen.getByText('No live conversations in this project.')).toBeTruthy()
    expect(screen.queryByLabelText('Search live conversations')).toBeNull()
  })
})
