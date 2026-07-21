/**
 * Builds the one-shot `initialData` an Excalidraw mount seeds from.
 *
 * Split out of excalidraw-canvas.tsx to keep that component inside the .tsx size
 * bar; the rule it encodes is subtle enough to deserve its own home anyway.
 *
 * A DSL Scene (v:1 + nodes) is EXPANDED to elements asynchronously (mermaid parses
 * through a lazy runtime) and pushed via the imperative API in useDslSeed, so its
 * initialData stays empty. A raw Excalidraw scene seeds directly. `collaborators`
 * is a Map (non-serializable) so it never survives a round-trip -- drop it
 * defensively before handing appState back to Excalidraw.
 *
 * Theme is seeded through appState (the DEFAULT), NOT the controlled `theme` prop:
 * the prop would LOCK the theme and override the user's in-app light/dark toggle
 * on every re-render. claudewerk is a dark app, so the canvas defaults to dark; the
 * user can still flip to light from the menu and that choice persists in appState
 * across the snapshot.
 */

import type { Excalidraw } from '@excalidraw/excalidraw'
import { isDslScene } from '@shared/draw-dsl'
import { type ComponentProps, useMemo } from 'react'

type InitialData = ComponentProps<typeof Excalidraw>['initialData']

// Parsed .excalidraw scene (serializeAsJSON output). Kept loose -- it is cast to
// Excalidraw's initialData shape at the boundary.
interface SceneSnapshot {
  elements?: unknown
  appState?: Record<string, unknown>
  files?: unknown
}

function buildInitialData(snapshot: unknown): InitialData {
  if (isDslScene(snapshot)) return { appState: { theme: 'dark' } }
  const s = snapshot as SceneSnapshot | undefined
  if (!s) return { appState: { theme: 'dark' }, scrollToContent: true }
  const { collaborators: _drop, ...appState } = s.appState ?? {}
  return {
    elements: s.elements,
    appState: { theme: 'dark', ...appState },
    files: s.files,
    scrollToContent: true,
  } as InitialData
}

/** Seed captured ONCE at mount -- later edits must never reset the canvas. */
export function useInitialData(snapshot: unknown): InitialData {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => buildInitialData(snapshot), [])
}
