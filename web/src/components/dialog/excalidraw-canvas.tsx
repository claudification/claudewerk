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
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { useCallback, useRef, useState } from 'react'
import { CANVAS_UI_OPTIONS, CanvasMainMenu } from '@/components/canvas/canvas-chrome'
import { type CanvasTheme, CanvasThemeScope, DEFAULT_CANVAS_THEME } from '@/components/canvas/canvas-theme'
import type { ChangeHandler, DrawCanvasProps, ExcalidrawAPI, ExcalidrawProps } from './excalidraw-canvas-types'
import { useInitialData } from './excalidraw-initial-data'
import { sceneSignature, seedSignature } from './excalidraw-scene-signature'
import { useCanvasFlush } from './use-canvas-flush'
import { useDslSeed } from './use-dsl-seed'

export type {
  CanvasCollabBinding,
  ChangeAppState,
  ChangeElements,
  ChangeFiles,
  DrawCanvasProps,
} from './excalidraw-canvas-types'

export default function ExcalidrawCanvas({
  initialSnapshot,
  readOnly,
  onSnapshot,
  collab,
  uploadFile,
  topRight,
  onThemeChange,
}: DrawCanvasProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Last content signature we acted on -- seeded from the initial scene so the
  // first settling onChange for an already-saved canvas is a no-op.
  const lastSig = useRef<string | null>(seedSignature(initialSnapshot))
  const apiRef = useRef<ExcalidrawAPI | null>(null)
  // react-doctor:rerender-state-only-in-handlers -- apiReady is read as a hook
  // dependency (useDslSeed), so it must be state to trigger the effect re-run.
  const [apiReady, setApiReady] = useState(false)

  // Seed captured once at mount -- see excalidraw-initial-data.ts for the rules.
  const initialData = useInitialData(initialSnapshot)

  // DSL seed + agent redraw: when the seeded DSL Scene REFERENCE changes (mount, or the
  // agent patched the block via update_dialog), (re-)expand and push through the live API.
  useDslSeed(apiRef, initialSnapshot, apiReady)

  // Persist + upload-new-files + emit files-less delta (see use-canvas-flush).
  const flushChange = useCanvasFlush(collab, onSnapshot, uploadFile)

  // The theme lives in appState, so a toggle arrives as a plain onChange -- and it
  // must be read BEFORE the readOnly / signature short-circuits below, which a
  // theme flip would otherwise be swallowed by (it changes no element).
  const lastTheme = useRef<CanvasTheme>(DEFAULT_CANVAS_THEME)
  const handleChange = useCallback<ChangeHandler>(
    (elements, appState, files) => {
      const theme = appState.theme === 'dark' ? 'dark' : 'light'
      if (theme !== lastTheme.current) {
        lastTheme.current = theme
        onThemeChange?.(theme)
      }
      if (readOnly) return
      // Only persist when the actual drawing changed. Excalidraw fires onChange
      // on pan/zoom/selection and on plain re-renders too; those keep the same
      // signature, so we ignore them and the save loop can't sustain itself.
      const sig = sceneSignature(elements, files)
      if (sig === lastSig.current) return
      lastSig.current = sig
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flushChange(elements, appState, files), 500)
    },
    [readOnly, flushChange, onThemeChange],
  )

  // Throttle cursor broadcasts -- onPointerUpdate fires on every mouse move. The
  // button EDGE (press/release) always flushes, throttle or not: Excalidraw only
  // starts a peer's laser trail on the 'down' frame and ends it on 'up', so a
  // dropped edge means a laser stroke that never draws or never stops.
  const lastPointerAt = useRef(0)
  const lastButton = useRef<'up' | 'down'>('up')
  const handlePointer = useCallback<NonNullable<ExcalidrawProps['onPointerUpdate']>>(
    payload => {
      if (!collab) return
      const now = performance.now()
      const edge = payload.button !== lastButton.current
      if (!edge && now - lastPointerAt.current < 50) return
      lastPointerAt.current = now
      lastButton.current = payload.button
      collab.onPointer(payload.pointer.x, payload.pointer.y, payload.pointer.tool, payload.button)
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
        // Constant on purpose: excalidraw only re-asserts this prop when it
        // CHANGES, so passing it pins the OPENING theme (over the saved scene's
        // appState) while leaving the in-app toggle free for the session.
        theme={DEFAULT_CANVAS_THEME}
        renderTopRightUI={
          topRight
            ? (_isMobile, appState) => (
                <CanvasThemeScope theme={appState.theme === 'dark' ? 'dark' : 'light'}>{topRight}</CanvasThemeScope>
              )
            : undefined
        }
      >
        <CanvasMainMenu />
      </Excalidraw>
    </div>
  )
}
