/**
 * Regression: BOTH canvas surfaces must open the dashboard WebSocket.
 *
 * Canvas live-multiplayer (join / cursors / laser / scene deltas) rides the
 * socket that useWebSocket() manages -- it stores `ws` (which wsSend reads) and
 * funnels inbound canvas_* messages. The owner /canvas/:id window bypasses <App>,
 * and the guest share view is early-returned before <App>'s useWebSocket calls,
 * so if these two components don't mount the hook themselves, the whole room is
 * silent (edits never propagate, no cursors). That was the shipped bug. These
 * tests fail if either surface stops calling useWebSocket().
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

// hoisted so the fn exists when the (hoisted) vi.mock factory runs.
const { useWebSocket } = vi.hoisted(() => ({ useWebSocket: vi.fn() }))
vi.mock('@/hooks/use-websocket', () => ({ useWebSocket }))

// Keep the heavy Excalidraw chunk out of jsdom -- these tests only assert the
// socket is mounted, not what the canvas renders.
vi.mock('@/components/dialog/excalidraw-canvas', () => ({ default: () => null }))

// Drive each surface down its cheapest 'missing' branch (still AFTER the
// useWebSocket() call, which sits at the very top of the component body).
vi.mock('./use-canvas-document', () => ({
  canvasIdFromPath: () => 'cnv_test',
  useCanvasDocument: () => ({ canvas: null, seed: null, state: 'missing', saveStore: {}, onSnapshot: () => {}, onRename: () => {} }),
}))
vi.mock('./use-public-canvas', () => ({
  usePublicCanvas: () => ({ doc: null, seed: null, state: 'missing', saveState: 'idle', onSnapshot: () => {} }),
}))
vi.mock('./use-guest-name', () => ({ useGuestName: () => ({ name: 'Snarky Whale', rename: () => {} }) }))

import { CanvasWindow } from './canvas-window'
import { PublicCanvasView } from './public-canvas-view'

afterEach(() => {
  cleanup()
  useWebSocket.mockClear()
})

describe('canvas surfaces open the dashboard socket', () => {
  test('owner CanvasWindow mounts useWebSocket', () => {
    render(<CanvasWindow />)
    expect(useWebSocket).toHaveBeenCalled()
  })

  test('guest PublicCanvasView mounts useWebSocket', () => {
    render(<PublicCanvasView token="tok_test" />)
    expect(useWebSocket).toHaveBeenCalled()
  })
})
