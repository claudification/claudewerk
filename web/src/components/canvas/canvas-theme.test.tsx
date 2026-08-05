/**
 * The scope's whole job is to re-declare the design tokens, so that is what is
 * asserted: a light canvas gets a light `--background`, a dark one gets the dark
 * palette, and neither is left to inherit whatever the control panel is wearing.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { findTheme } from '@/lib/themes'
import { CanvasThemeScope, DEFAULT_CANVAS_THEME } from './canvas-theme'

afterEach(cleanup)

function scopeStyle(theme: 'light' | 'dark') {
  const { container } = render(
    <CanvasThemeScope theme={theme}>
      <span>chrome</span>
    </CanvasThemeScope>,
  )
  return (container.firstElementChild as HTMLElement).style
}

describe('CanvasThemeScope', () => {
  test('a canvas opens light', () => {
    expect(DEFAULT_CANVAS_THEME).toBe('light')
  })

  test('light scope carries the light palette', () => {
    expect(scopeStyle('light').getPropertyValue('--background')).toBe(findTheme('github-light').variables.background)
  })

  test('dark scope carries the dark palette', () => {
    expect(scopeStyle('dark').getPropertyValue('--background')).toBe(findTheme('tokyo-night').variables.background)
  })

  test("sets the text colour explicitly, so nothing inherits excalidraw's", () => {
    const { container } = render(
      <CanvasThemeScope theme="light">
        <span>chrome</span>
      </CanvasThemeScope>,
    )
    expect((container.firstElementChild as HTMLElement).className).toContain('text-foreground')
  })
})
