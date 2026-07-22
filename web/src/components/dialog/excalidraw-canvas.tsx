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
import { isDslScene } from '@shared/draw-dsl'
import { type ComponentProps, type ReactNode, useCallback, useRef, useState } from 'react'
import { CANVAS_UI_OPTIONS, CanvasMainMenu } from '@/components/canvas/canvas-chrome'
import { useCanvasFlush } from './use-canvas-flush'
import { useInitialData } from './excalidraw-initial-data'
import { useDslSeed } from './use-dsl-seed'

type ExcalidrawProps = ComponentProps<typeof Excalidraw>
type ChangeHandler = NonNullable<ExcalidrawProps['onChange']>
export type ChangeElements = Parameters<ChangeHandler>[0]
export type ChangeAppState = Parameters<ChangeHandler>[1]
export type ChangeFiles = Parameters<ChangeHandler>[2]
type ExcalidrawAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]

/**
 * A cheap fingerprint of the scene's CONTENT -- element ids + their bumping
 * `version` (which ticks on any create/edit/delete) plus the file-id set.
 * Deliberately excludes appState, so pan / zoom / selection / a bare re-render
 * do NOT count as a change. That is what stops the phantom-save loop: Excalidraw
 * fires `onChange` for those non-content reasons too, and without this guard each
 * one scheduled a real save whose state-flip re-rendered us into the next onChange.
 */
function sceneSignature(elements: ChangeElements, files: ChangeFiles | undefined): string {
  let sig = ''
  for (const el of elements) sig += `${el.id}:${el.version};`
  return `${sig}|${files ? Object.keys(files).join(',') : ''}`
}

/** Baseline signature from the seed, so reopening a saved scene doesn't fire a
 *  spurious save on its very first (settling) onChange. DSL/blank seed -> null
 *  (the async expansion legitimately persists once). */
function seedSignature(snapshot: unknown): string | null {
  if (!snapshot || isDslScene(snapshot)) return null
  const s = snapshot as { elements?: ChangeElements; files?: ChangeFiles }
  if (!s.elements) return null
  return sceneSignature(s.elements, s.files)
}

/** Opt-in live-collaboration wiring (hosted canvas multiplayer, Phase E). When
 *  present, the canvas streams cursors + scene changes to peers and applies
 *  theirs via the imperative API. Absent for the Draw dialog block (unchanged). */
export interface CanvasCollabBinding {
  /** Receive the Excalidraw API so the collab layer can updateScene() + addFiles(). */
  bindApi: (
    api: {
      updateScene(scene: { elements?: readonly unknown[]; collaborators?: Map<string, unknown> }): void
      addFiles?(files: readonly unknown[]): void
      getFiles?(): Record<string, unknown>
    } | null,
  ) => void
  /** Local cursor moved (scene coords). tool + button ride along so a remote
   *  Excalidraw can draw this peer's laser trail (needs tool 'laser' + button
   *  'down'); both default sensibly when omitted (plain cursor). */
  onPointer: (x: number, y: number, tool?: 'pointer' | 'laser', button?: 'up' | 'down') => void
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
  /** Upload an image's bytes to the canvas file slot. When present, image bytes go
   *  to the slot and the WS delta carries only fileIds (kept off the hot path);
   *  when absent (Draw block), files stay inline in the delta. */
  uploadFile?: (fileId: string, dataURL: string) => Promise<void>
  /** Chrome to float in excalidraw's own top-right island stack (hosted canvas
   *  name / save state / presence / Share). Undefined = no island (Draw block). */
  topRight?: ReactNode
}

export default function ExcalidrawCanvas({
  initialSnapshot,
  readOnly,
  onSnapshot,
  collab,
  uploadFile,
  topRight,
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

  const handleChange = useCallback<ChangeHandler>(
    (elements, appState, files) => {
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
    [readOnly, flushChange],
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
        renderTopRightUI={topRight ? () => <>{topRight}</> : undefined}
      >
        <CanvasMainMenu />
      </Excalidraw>
    </div>
  )
}
