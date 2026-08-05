/**
 * The canvas component's public shape -- props and the Excalidraw-derived change
 * types -- split out of excalidraw-canvas.tsx so that file stays a component.
 *
 * Everything here is re-exported from excalidraw-canvas, so importers can keep
 * pulling both the default export and its types from one place.
 */

import type { Excalidraw } from '@excalidraw/excalidraw'
import type { ComponentProps, ReactNode } from 'react'
import type { CanvasTheme } from '@/components/canvas/canvas-theme'

export type ExcalidrawProps = ComponentProps<typeof Excalidraw>
export type ChangeHandler = NonNullable<ExcalidrawProps['onChange']>
export type ChangeElements = Parameters<ChangeHandler>[0]
export type ChangeAppState = Parameters<ChangeHandler>[1]
export type ChangeFiles = Parameters<ChangeHandler>[2]
export type ExcalidrawAPI = Parameters<NonNullable<ExcalidrawProps['excalidrawAPI']>>[0]

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
  /** The user flipped excalidraw's own dark-mode toggle. Only surfaces for chrome
   *  rendered OUTSIDE the canvas (the share viewer's header); the floating
   *  top-right chrome is themed from excalidraw's appState directly. */
  onThemeChange?: (theme: CanvasTheme) => void
}
