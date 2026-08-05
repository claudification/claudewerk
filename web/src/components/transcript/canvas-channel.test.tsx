/**
 * A canvas message must answer two questions at a glance: WHICH canvas (and get
 * me there), and WHAT was it pointing at. Neither may arrive as raw XML.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const { openCanvasWindow } = vi.hoisted(() => ({ openCanvasWindow: vi.fn() }))
vi.mock('@/components/canvas/open-canvas-window', () => ({ openCanvasWindow }))
// The name lookup is a fetch; the link must work (and read) without it.
vi.mock('@/components/canvas/use-canvas-name', () => ({ useCanvasName: () => null }))

import { CanvasChannel } from './canvas-channel'

afterEach(() => {
  cleanup()
  openCanvasWindow.mockClear()
})

const CHIPS = [{ id: 'ytaVE08z', type: 'rectangle', label: 'CLAUDE', stroke: '#1971c2', fill: '#ffc9c9' }]

describe('CanvasChannel', () => {
  test('renders the selection as a chip, not as markup', () => {
    render(<CanvasChannel text="make sense of this" canvasId="cnv_6ec4c5e2" chips={CHIPS} />)
    expect(screen.getByText('CLAUDE')).toBeTruthy()
    expect(screen.queryByText(/<selected/)).toBeNull()
  })

  test('the canvas is clickable and opens that canvas', () => {
    render(<CanvasChannel text="hi" canvasId="cnv_6ec4c5e2" chips={[]} />)
    fireEvent.click(screen.getByTitle('Open canvas cnv_6ec4c5e2'))
    expect(openCanvasWindow).toHaveBeenCalledWith('cnv_6ec4c5e2')
  })

  test('falls back to a short id while the name is unknown', () => {
    render(<CanvasChannel text="hi" canvasId="cnv_6ec4c5e2-bd24" chips={[]} />)
    expect(screen.getByTitle('Open canvas cnv_6ec4c5e2-bd24').textContent).toBe('6ec4c5e2')
  })

  test('a big selection reads as a census', () => {
    render(
      <CanvasChannel
        text="tidy"
        canvasId="cnv_x"
        chips={[]}
        census={{ count: 42, summary: '30 rectangle, 12 arrow' }}
      />,
    )
    expect(screen.getByText(/42/)).toBeTruthy()
    expect(screen.getByText(/30 rectangle, 12 arrow/)).toBeTruthy()
  })

  test('no selection means no chip row -- just the message', () => {
    render(<CanvasChannel text="just talking" canvasId="cnv_x" chips={[]} />)
    expect(screen.queryByText('pointing at')).toBeNull()
    expect(screen.getByText('just talking')).toBeTruthy()
  })
})
