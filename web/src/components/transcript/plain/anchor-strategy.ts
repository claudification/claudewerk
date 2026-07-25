/**
 * Who holds the reader's position while content above them changes?
 *
 * Two candidates, and running both at once double-compensates:
 *
 *  - NATIVE (`overflow-anchor: auto`) -- browser scroll anchoring. It picks a
 *    node in the viewport and preserves ITS position across layout, in the
 *    layout phase, so it can never be a frame late and it cannot be starved by
 *    a ResizeObserver depth limit. Strictly better where it exists.
 *  - JS -- our prepend anchor + above-viewport anchor. Necessary only where
 *    native anchoring does not exist.
 *
 * Native anchoring shipped in Chrome and Firefox years ago and landed in WebKit
 * in Safari Technology Preview 238 (Feb 2026), riding to release in Safari 27.
 * So the JS path is now a FALLBACK for Safari 26 and older, not the main road:
 * on Safari 27+ this flips itself over with no code change. `CSS.supports` is
 * the honest probe -- an engine that never implemented the property fails to
 * parse the value and reports false.
 */

export type AnchorMode = 'auto' | 'native' | 'js'
export type GroupSizing = 'measured' | 'flat'

export interface AnchorStrategy {
  /** CSS `overflow-anchor` for the scroller. */
  overflowAnchor: 'none' | 'auto'
  /** Run the scrollHeight-delta prepend anchor (use-prepend-anchor.ts). */
  prependAnchor: boolean
  /** Run the above-viewport ResizeObserver anchor (use-above-anchor.ts). */
  aboveAnchor: boolean
  /** What `auto` actually resolved to -- shown in the lab, logged on mount. */
  resolved: 'native' | 'js'
}

const NATIVE: AnchorStrategy = {
  overflowAnchor: 'auto',
  prependAnchor: false,
  aboveAnchor: false,
  resolved: 'native',
}

const JS: AnchorStrategy = {
  overflowAnchor: 'none',
  prependAnchor: true,
  aboveAnchor: true,
  resolved: 'js',
}

/** Does this engine implement CSS scroll anchoring? */
function supportsScrollAnchoring(): boolean {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false
  return CSS.supports('overflow-anchor', 'auto')
}

export function resolveAnchorStrategy(
  mode: AnchorMode,
  supported: boolean = supportsScrollAnchoring(),
): AnchorStrategy {
  if (mode === 'native') return NATIVE
  if (mode === 'js') return JS
  return supported ? NATIVE : JS
}
