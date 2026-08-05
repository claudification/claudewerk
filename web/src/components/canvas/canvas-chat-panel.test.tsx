/**
 * The chat is OPT IN: a freshly opened canvas must not have a conversation
 * picker sitting on top of the drawing.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CanvasChatPanel } from './canvas-chat-panel'
import type { CanvasChat } from './use-canvas-chat'

const CHAT: CanvasChat = {
  candidates: [{ id: 'a', name: 'nuclear-pelican', status: 'active' }],
  connectedId: null,
  connectedName: null,
  lines: [],
  error: null,
  connect: vi.fn(),
  send: vi.fn(),
}

afterEach(cleanup)

describe('CanvasChatPanel', () => {
  test('mounts collapsed -- header only, no picker', () => {
    render(<CanvasChatPanel chat={CHAT} />)
    expect(screen.getByText('Chat')).toBeTruthy()
    expect(screen.queryByText('nuclear-pelican')).toBeNull()
  })

  test('expands on demand', () => {
    render(<CanvasChatPanel chat={CHAT} />)
    fireEvent.click(screen.getByLabelText('Expand the chat'))
    expect(screen.getByText('nuclear-pelican')).toBeTruthy()
  })
})
