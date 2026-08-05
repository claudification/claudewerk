/**
 * The scene fingerprint that decides whether an onChange is worth saving.
 *
 * Split out of excalidraw-canvas.tsx: this is pure, it is the subtlest rule in
 * the canvas, and it deserves to be readable on its own.
 */

import { isDslScene } from '@shared/draw-dsl'
import type { ChangeElements, ChangeFiles } from './excalidraw-canvas-types'

/**
 * A cheap fingerprint of the scene's CONTENT -- element ids + their bumping
 * `version` (which ticks on any create/edit/delete) plus the file-id set.
 * Deliberately excludes appState, so pan / zoom / selection / theme / a bare
 * re-render do NOT count as a change. That is what stops the phantom-save loop:
 * Excalidraw fires `onChange` for those non-content reasons too, and without this
 * guard each one scheduled a real save whose state-flip re-rendered us into the
 * next onChange.
 */
export function sceneSignature(elements: ChangeElements, files: ChangeFiles | undefined): string {
  let sig = ''
  for (const el of elements) sig += `${el.id}:${el.version};`
  return `${sig}|${files ? Object.keys(files).join(',') : ''}`
}

/** Baseline signature from the seed, so reopening a saved scene doesn't fire a
 *  spurious save on its very first (settling) onChange. DSL/blank seed -> null
 *  (the async expansion legitimately persists once). */
export function seedSignature(snapshot: unknown): string | null {
  if (!snapshot || isDslScene(snapshot)) return null
  const s = snapshot as { elements?: ChangeElements; files?: ChangeFiles }
  if (!s.elements) return null
  return sceneSignature(s.elements, s.files)
}
