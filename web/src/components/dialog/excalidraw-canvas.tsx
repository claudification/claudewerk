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
import { type ComponentProps, type ReactNode, useCallback, useRef, useState } from 'react'
import { CANVAS_UI_OPTIONS, CanvasMainMenu } from '@/components/canvas/canvas-chrome'
import { useInitialData } from './excalidraw-initial-data'
import { useDslSeed } from './use-dsl-seed'

type ExcalidrawProps = ComponentProps<typeof Excalidraw>
type ChangeHandler = NonNullable<ExcalidrawProps['onChange']>
type ExcalidrawAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]

/** Opt-in live-collaboration wiring (hosted canvas multiplayer, Phase E). When
 *  present, the canvas streams cursors + scene changes to peers and applies
 *  theirs via the imperative API. Absent for the Draw dialog block (unchanged). */
export interface CanvasCollabBinding {
  /** Receive the Excalidraw API so the collab layer can updateScene(). */
  bindApi: (
    api: { updateScene(scene: { elements?: readonly unknown[]; collaborators?: Map<string, unknown> }): void } | null,
  ) => void
  /** Local cursor moved (scene coords). */
  onPointer: (x: number, y: number) => void
  /** Local scene changed -- serialized JSON. */
  onChange: (json: string) => void
}

export interface DrawCanvasProps {
  /** Parsed Excalidraw scene to seed the canvas (null = blank). */
  initialSnapshot?: unknown
  readOnly?: boolean
  /** Debounced: fires with the serialized scene JSON whenever the user edits. */
  onSnapshot?: (json: string, bytes: number) => void
  /** Opt-in multiplayer binding. Undefined = solo (Draw block, private canvas). */
  collab?: CanvasCollabBinding
  /** Chrome to float in excalidraw's own top-right island stack (hosted canvas
   *  name / save state / presence / Share). Undefined = no island (Draw block). */
  topRight?: ReactNode
}

export default function ExcalidrawCanvas({
  initialSnapshot,
  readOnly,
  onSnapshot,
  collab,
  topRight,
}: DrawCanvasProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const apiRef = useRef<ExcalidrawAPI | null>(null)
  // react-doctor:rerender-state-only-in-handlers -- apiReady is read as a hook
  // dependency (useDslSeed), so it must be state to trigger the effect re-run.
  const [apiReady, setApiReady] = useState(false)

  // Seed captured once at mount -- see excalidraw-initial-data.ts for the rules.
  const initialData = useInitialData(initialSnapshot)

  // DSL seed + agent redraw: when the seeded DSL Scene REFERENCE changes (mount, or the
  // agent patched the block via update_dialog), (re-)expand and push through the live API.
  useDslSeed(apiRef, initialSnapshot, apiReady)

  const handleChange = useCallback<ChangeHandler>(
    (elements, appState, files) => {
      if (readOnly) return
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        const json = serializeAsJSON(elements, appState, files, 'local')
        onSnapshot?.(json, utf8Bytes(json))
        collab?.onChange(json)
      }, 500)
    },
    [readOnly, onSnapshot, collab],
  )

  // Throttle cursor broadcasts -- onPointerUpdate fires on every mouse move.
  const lastPointerAt = useRef(0)
  const handlePointer = useCallback<NonNullable<ExcalidrawProps['onPointerUpdate']>>(
    payload => {
      if (!collab) return
      const now = performance.now()
      if (now - lastPointerAt.current < 50) return
      lastPointerAt.current = now
      collab.onPointer(payload.pointer.x, payload.pointer.y)
    },
    [collab],
  )

  // .canvas-chrome scopes the CSS-only chrome trims (see canvas-chrome.css).
  return (
    <div className="canvas-chrome w-full h-full">
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={api => {
          apiRef.current = api
          setApiReady(true)
          collab?.bindApi(api as unknown as Parameters<NonNullable<DrawCanvasProps['collab']>['bindApi']>[0])
        }}
        viewModeEnabled={readOnly}
        onChange={handleChange}
        onPointerUpdate={collab ? handlePointer : undefined}
        UIOptions={CANVAS_UI_OPTIONS}
        renderTopRightUI={topRight ? () => <>{topRight}</> : undefined}
      >
        <CanvasMainMenu />
      </Excalidraw>
    </div>
  )
}
