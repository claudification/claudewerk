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
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { CANVAS_UI_OPTIONS, CanvasMainMenu } from '@/components/canvas/canvas-chrome'
import { CanvasThemeScope, DEFAULT_CANVAS_THEME, themeOf, useCanvasThemeWatch } from '@/components/canvas/canvas-theme'
import type { ChangeHandler, DrawCanvasProps, ExcalidrawAPI, ExcalidrawProps } from './excalidraw-canvas-types'
import { useInitialData } from './excalidraw-initial-data'
import { sceneSignature, seedSignature } from './excalidraw-scene-signature'
import { isPreSeedBlank } from './pre-seed-blank'
import { useCanvasFlush } from './use-canvas-flush'
import { useDslSeed } from './use-dsl-seed'
import { usePointerBroadcast } from './use-pointer-broadcast'

export type {
  CanvasCollabBinding,
  ChangeAppState,
  ChangeElements,
  ChangeFiles,
  DrawCanvasProps,
} from './excalidraw-canvas-types'

/** Our chrome, dressed in the canvas's own theme. Excalidraw hands the live
 *  appState to this hook on every render, so the scope follows a theme toggle
 *  without any state of ours. */
function themedTopRight(topRight: ReactNode): ExcalidrawProps['renderTopRightUI'] {
  if (!topRight) return undefined
  return (_isMobile, appState) => <CanvasThemeScope theme={themeOf(appState.theme)}>{topRight}</CanvasThemeScope>
}

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
  // While that expansion is in flight the canvas is legitimately empty -- see below.
  const dslSeedPending = useDslSeed(apiRef, initialSnapshot, apiReady)

  // Persist + upload-new-files + emit files-less delta (see use-canvas-flush).
  const flushChange = useCanvasFlush(collab, onSnapshot, uploadFile)

  // The theme lives in appState, so a toggle arrives as a plain onChange -- and it
  // must be read BEFORE the readOnly / signature short-circuits below, which a
  // theme flip would otherwise be swallowed by (it changes no element).
  const watchTheme = useCanvasThemeWatch(onThemeChange)
  const handleChange = useCallback<ChangeHandler>(
    (elements, appState, files) => {
      watchTheme(themeOf(appState.theme))
      if (readOnly) return
      // An empty canvas whose DSL seed has not landed yet is NOT an edit. Saving
      // it wrote a blank scene over the drawing and broadcast the blank to every
      // open viewer (see pre-seed-blank.ts).
      if (isPreSeedBlank({ dslSeedPending, elementCount: elements.length })) return
      // Only persist when the actual drawing changed. Excalidraw fires onChange
      // on pan/zoom/selection and on plain re-renders too; those keep the same
      // signature, so we ignore them and the save loop can't sustain itself.
      const sig = sceneSignature(elements, files)
      if (sig === lastSig.current) return
      lastSig.current = sig
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flushChange(elements, appState, files), 500)
    },
    [readOnly, flushChange, watchTheme, dslSeedPending],
  )

  // Throttled cursor frames for multiplayer -- undefined when solo.
  const handlePointer = usePointerBroadcast(collab)

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
        onPointerUpdate={handlePointer}
        UIOptions={CANVAS_UI_OPTIONS}
        // Constant on purpose: excalidraw only re-asserts this prop when it
        // CHANGES, so passing it pins the OPENING theme (over the saved scene's
        // appState) while leaving the in-app toggle free for the session.
        theme={DEFAULT_CANVAS_THEME}
        renderTopRightUI={themedTopRight(topRight)}
      >
        <CanvasMainMenu />
      </Excalidraw>
    </div>
  )
}
