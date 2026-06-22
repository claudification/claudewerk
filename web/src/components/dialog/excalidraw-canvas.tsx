/**
 * Excalidraw canvas -- its OWN lazy chunk (heavy; loaded only when a Draw block paints,
 * LAZY LOAD covenant). Mirrors the old tldraw DrawCanvas interface exactly so draw-block
 * can swap implementations with a one-line import change.
 *
 * Why Excalidraw over tldraw: MIT, no license key, no watermark, no production blanking,
 * faster to settle (no license-check grace). The agent round-trip is unchanged in shape:
 *
 *   "snapshot" = Excalidraw's serializeAsJSON output (the .excalidraw scene: elements +
 *   appState + files), the analogue of tldraw's store snapshot. The agent seeds via
 *   initialData and reads the same JSON back on submit; images live in `files` and travel
 *   with it. draw-block.tsx, draw-spill.ts and the wire payload ({kind:'draw',snapshot,
 *   bytes}) stay format-agnostic, so nothing downstream changes.
 *
 * NOTE: Excalidraw fetches its fonts from a CDN by default. To self-host, set
 * window.EXCALIDRAW_ASSET_PATH and ship dist assets -- a follow-up, not needed for the spike.
 */
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { utf8Bytes } from '@shared/draw'
import { type ComponentProps, useCallback, useMemo, useRef } from 'react'

type ExcalidrawProps = ComponentProps<typeof Excalidraw>
type ChangeHandler = NonNullable<ExcalidrawProps['onChange']>

export interface DrawCanvasProps {
  /** Parsed Excalidraw scene to seed the canvas (null = blank). */
  initialSnapshot?: unknown
  readOnly?: boolean
  /** Debounced: fires with the serialized scene JSON whenever the user edits. */
  onSnapshot?: (json: string, bytes: number) => void
}

// Parsed .excalidraw scene (serializeAsJSON output). Kept loose -- it is cast to
// Excalidraw's initialData shape at the boundary.
interface SceneSnapshot {
  elements?: unknown
  appState?: Record<string, unknown>
  files?: unknown
}

export default function ExcalidrawCanvas({ initialSnapshot, readOnly, onSnapshot }: DrawCanvasProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Seed once from the snapshot. collaborators is a Map (non-serializable) so it never
  // survives a round-trip -- drop it defensively before handing appState back to Excalidraw.
  //
  // Theme: seeded through appState (the DEFAULT), not the controlled `theme` prop -- the prop
  // would LOCK the theme and override the user's in-app light/dark toggle on every re-render.
  // claudewerk is a dark app, so we default the canvas to dark; the user can still flip to
  // light from Excalidraw's menu, and that choice persists in appState across the snapshot.
  const initialData = useMemo<ExcalidrawProps['initialData']>(() => {
    const s = initialSnapshot as SceneSnapshot | undefined
    if (!s) return { appState: { theme: 'dark' }, scrollToContent: true }
    const { collaborators: _drop, ...appState } = s.appState ?? {}
    return {
      elements: s.elements,
      appState: { theme: 'dark', ...appState },
      files: s.files,
      scrollToContent: true,
    } as ExcalidrawProps['initialData']
    // seed captured once at mount; later edits must not reset the canvas
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleChange = useCallback<ChangeHandler>(
    (elements, appState, files) => {
      if (readOnly || !onSnapshot) return
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const json = serializeAsJSON(elements, appState, files, 'local')
        onSnapshot(json, utf8Bytes(json))
      }, 500)
    },
    [readOnly, onSnapshot],
  )

  return <Excalidraw initialData={initialData} viewModeEnabled={readOnly} onChange={handleChange} />
}
