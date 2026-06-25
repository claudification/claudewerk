/**
 * Load + save helpers for the hosted canvas editor. Kept out of the overlay
 * component so the .tsx stays focused on chrome + state. Saves include a small
 * PNG thumbnail (exported from the scene) so the Project Action Panel list can
 * render a preview. Every save fires rclaude-canvas-changed so the list
 * refreshes.
 */

import type { CanvasSummary } from '@shared/protocol'
import { exportScenePng } from '@/components/dialog/draw-export'
import { appendShareParam } from '@/lib/share-mode'

export interface LoadedCanvas {
  canvas: CanvasSummary
  /** Serialized Excalidraw scene JSON, or null for a blank canvas. */
  scene: string | null
}

export async function loadCanvas(canvasId: string): Promise<LoadedCanvas | null> {
  const res = await fetch(appendShareParam(`/api/canvases/${encodeURIComponent(canvasId)}`))
  if (!res.ok) return null
  return (await res.json()) as LoadedCanvas
}

/** Render a scene to a small PNG and return it as a data: URL (or undefined). */
async function sceneThumbDataUrl(sceneJson: string): Promise<string | undefined> {
  try {
    const blob = await exportScenePng(sceneJson, { maxWidthOrHeight: 320 })
    if (!blob) return undefined
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result as string)
      fr.onerror = () => reject(fr.error)
      fr.readAsDataURL(blob)
    })
  } catch {
    return undefined
  }
}

/** Persist a scene (with a fresh thumbnail). Returns true on success. */
export async function saveCanvasScene(canvasId: string, sceneJson: string): Promise<boolean> {
  const thumb = await sceneThumbDataUrl(sceneJson)
  const res = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/scene`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scene: sceneJson, thumb }),
  })
  if (res.ok) window.dispatchEvent(new CustomEvent('rclaude-canvas-changed'))
  return res.ok
}

/** Rename a canvas. Returns true on success. */
export async function renameCanvas(canvasId: string, name: string): Promise<boolean> {
  const res = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (res.ok) window.dispatchEvent(new CustomEvent('rclaude-canvas-changed'))
  return res.ok
}
