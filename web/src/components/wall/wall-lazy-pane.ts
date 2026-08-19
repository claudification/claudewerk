/**
 * One `React.lazy` per pane code, created ONCE.
 *
 * Calling `lazy()` during render would hand React a new component type every
 * pass, which remounts the pane body (and re-fetches its chunk) on every wall
 * re-render -- and a wall re-renders constantly, being a live surface. Cached by
 * code, at module scope, so it cannot happen.
 */

import { type ComponentType, lazy } from 'react'
import type { WallPaneEntry } from './wall-pane-registry'

const cache = new Map<string, ComponentType>()

export function lazyPane(entry: WallPaneEntry): ComponentType {
  const hit = cache.get(entry.code)
  if (hit) return hit
  const Pane = lazy(entry.load)
  cache.set(entry.code, Pane)
  return Pane
}
