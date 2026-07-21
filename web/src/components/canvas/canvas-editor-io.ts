/**
 * Load + save helpers for the hosted canvas editor. Kept out of the overlay
 * component so the .tsx stays focused on chrome + state. Saves include a small
 * PNG thumbnail (exported from the scene) so the Project Action Panel list can
 * render a preview. Every save fires rclaude-canvas-changed so the list
 * refreshes.
 */

import type { CanvasShareTier, CanvasSummary } from '@shared/protocol'
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

/** Public link for a share token. `/c/:token` redirects into the SPA viewer. */
export function canvasShareUrl(token: string): string {
  return `${window.location.origin}/c/${encodeURIComponent(token)}`
}

/**
 * Create/update the public share at a tier. `expiresInHours` null = until revoked.
 * Returns the token plus the resolved deadline the broker actually stored, which
 * is the value the UI counts down from (never a locally-computed guess).
 */
export async function shareCanvas(
  canvasId: string,
  tier: CanvasShareTier,
  expiresInHours: number | null,
): Promise<{ token: string; expiresAt?: number } | null> {
  const res = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/share`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier, expiresInHours }),
  })
  if (!res.ok) return null
  const { shareToken, canvas } = (await res.json()) as { shareToken?: string; canvas?: CanvasSummary }
  window.dispatchEvent(new CustomEvent('rclaude-canvas-changed'))
  return shareToken ? { token: shareToken, expiresAt: canvas?.shareExpiresAt } : null
}

/** Revoke the public share -- the old link goes dead immediately. */
export async function revokeCanvasShare(canvasId: string): Promise<boolean> {
  const res = await fetch(`/api/canvases/${encodeURIComponent(canvasId)}/share`, { method: 'DELETE' })
  if (res.ok) window.dispatchEvent(new CustomEvent('rclaude-canvas-changed'))
  return res.ok
}
