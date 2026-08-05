/**
 * Regression: the Share popover opened UNDER the chat panel. Each island is its
 * own stacking context (backdrop-blur), so the ordering has to live on the LAYER,
 * not inside a child.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { CanvasIslandLayer } from './canvas-island-stack'

afterEach(cleanup)

function layerClasses() {
  const { container } = render(
    <CanvasIslandLayer>
      <span>island</span>
    </CanvasIslandLayer>,
  )
  return (container.firstElementChild as HTMLElement).className
}

describe('CanvasIslandLayer', () => {
  test('the focused island wins', () => {
    expect(layerClasses()).toContain('focus-within:z-30')
  })

  test('an open popover outranks a plain neighbour', () => {
    expect(layerClasses()).toContain('has-[[data-canvas-popover]]:z-20')
  })

  test('carries a z-index at rest, so the raised states have something to beat', () => {
    expect(layerClasses()).toContain('z-0')
  })
})
