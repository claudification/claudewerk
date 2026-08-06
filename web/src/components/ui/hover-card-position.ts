/**
 * Where a hover panel lands. Pure geometry, split out of the component so the
 * flip-above rule is unit-testable without a DOM.
 *
 * The panel is FIXED-positioned at the trigger's viewport rect (it portals to
 * body, so a dense list row can't clip it). Below is preferred; when below is
 * cramped and above has more room it anchors by `bottom` instead -- which also
 * makes it grow upward rather than off-screen.
 */

export const DEFAULT_PANEL_WIDTH = 340
const VIEWPORT_MARGIN = 8
const GAP = 6
/** Below this much room under the trigger, consider flipping above. */
const CRAMPED_BELOW = 160

export interface HoverCoords {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

export interface Viewport {
  width: number
  height: number
}

export function computeHoverCoords(
  rect: { left: number; top: number; bottom: number },
  viewport: Viewport,
  panelWidth: number = DEFAULT_PANEL_WIDTH,
): HoverCoords {
  const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, viewport.width - panelWidth - VIEWPORT_MARGIN))
  const spaceBelow = viewport.height - rect.bottom
  const spaceAbove = rect.top
  if (spaceBelow < CRAMPED_BELOW && spaceAbove > spaceBelow) {
    return { left, bottom: viewport.height - rect.top + GAP, maxHeight: spaceAbove - VIEWPORT_MARGIN - GAP }
  }
  return { left, top: rect.bottom + GAP, maxHeight: spaceBelow - VIEWPORT_MARGIN - GAP }
}
