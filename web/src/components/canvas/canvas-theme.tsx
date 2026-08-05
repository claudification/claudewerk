/**
 * A canvas is a LIGHT surface, and our chrome floats ON it.
 *
 * Two rules (Jonas, 2026-08-05):
 *
 *  - A canvas OPENS LIGHT. Not "whatever the control panel is wearing", not
 *    "whatever the scene was last saved as" -- drawings are ink on paper, and
 *    the shared/exported artifact should look the same for everyone. Excalidraw's
 *    own toggle (Shift+Option+D) still flips it for the session.
 *  - The chrome follows the CANVAS, not the app. Chat, Share and the island sit
 *    inside excalidraw's own layer; when the canvas was light and the panel dark,
 *    they read as a dark box glued onto a white page -- and the connect rows went
 *    literally invisible, because they inherited excalidraw's dark-on-light text
 *    onto our dark panel.
 *
 * Mechanism: re-declare the design tokens on a wrapper. The values come from the
 * SHARED theme table (`@/lib/themes`), so this file owns a mapping, never a
 * palette -- retheming the panel retheme's the canvas chrome for free.
 */

import { type CSSProperties, type ReactNode, useCallback, useRef } from 'react'
import { findTheme } from '@/lib/themes'
import { cn } from '@/lib/utils'

export type CanvasTheme = 'light' | 'dark'

/** Excalidraw's appState theme, narrowed. Anything unexpected reads as light --
 *  the default, and the safer half of a wrong guess (dark chrome on white paper
 *  is the bug this file exists to kill). */
export function themeOf(theme: unknown): CanvasTheme {
  return theme === 'dark' ? 'dark' : 'light'
}

/** What a canvas opens as, everywhere. */
export const DEFAULT_CANVAS_THEME: CanvasTheme = 'light'

/** Which control-panel theme dresses each canvas theme. */
const THEME_ID: Record<CanvasTheme, string> = { light: 'github-light', dark: 'tokyo-night' }

function toVars(theme: CanvasTheme): CSSProperties {
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(findTheme(THEME_ID[theme]).variables)) vars[`--${key}`] = value
  return vars as CSSProperties
}

/** Built once -- the token sets are static. */
const VARS: Record<CanvasTheme, CSSProperties> = { light: toVars('light'), dark: toVars('dark') }

/**
 * Report a theme flip, once per flip.
 *
 * Excalidraw only announces the theme inside `onChange`, which also fires for
 * every pan, zoom and keystroke -- so the edge has to be found here rather than
 * handed to a caller that would re-render on each frame.
 */
export function useCanvasThemeWatch(onThemeChange?: (theme: CanvasTheme) => void) {
  const last = useRef<CanvasTheme>(DEFAULT_CANVAS_THEME)
  return useCallback(
    (theme: CanvasTheme) => {
      if (theme === last.current) return
      last.current = theme
      onThemeChange?.(theme)
    },
    [onThemeChange],
  )
}

/**
 * Scope every design token to the canvas's theme. `text-foreground` is explicit
 * on purpose: without it the children inherit excalidraw's text colour, which is
 * the opposite of ours the moment the two themes disagree.
 */
export function CanvasThemeScope({
  theme,
  className,
  children,
}: {
  theme: CanvasTheme
  className?: string
  children: ReactNode
}) {
  return (
    <div style={VARS[theme]} className={cn('text-foreground', className)}>
      {children}
    </div>
  )
}
