/**
 * Guest-side I/O for a publicly shared canvas (no auth -- the token is the
 * capability). Reads/writes go through /shared/public/canvas/:token, which the
 * broker tier-gates + sanitizes. For the comment tier, the guest's new elements
 * are tagged as annotations client-side so the broker accepts them (a base-design
 * mutation is still rejected server-side -- this only auto-tags ADDED elements).
 */

import type { CanvasShareTier } from '@shared/protocol'

/** Must match CANVAS_ANNOTATION_KEY in src/broker/canvas-sanitize.ts. */
const ANNOTATION_KEY = 'canvasAnnotation'

export interface PublicCanvas {
  canvas: { id: string; name: string; updatedAt: number }
  tier: CanvasShareTier
  scene: string | null
}

export async function loadPublicCanvas(token: string): Promise<PublicCanvas | null> {
  const res = await fetch(`/shared/public/canvas/${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null
  return (await res.json()) as PublicCanvas
}

/** Element ids present in a scene (used to distinguish guest additions). */
export function sceneElementIds(sceneJson: string | null): Set<string> {
  if (!sceneJson) return new Set()
  try {
    const s = JSON.parse(sceneJson) as { elements?: { id?: string }[] }
    return new Set((s.elements ?? []).flatMap(e => { const id = String(e.id); return id ? [id] : [] }))
  } catch {
    return new Set()
  }
}

/**
 * Tag every element NOT in `baseIds` as a guest annotation. Used for the comment
 * tier so a guest's freshly drawn shapes carry customData.canvasAnnotation and
 * pass the broker's comment-tier check (which forbids touching base elements).
 */
// fallow-ignore-next-line complexity -- parse-guard + a single tag loop, irreducible.
export function tagAnnotations(sceneJson: string, baseIds: Set<string>): string {
  let s: { elements?: Record<string, unknown>[] }
  try {
    s = JSON.parse(sceneJson)
  } catch {
    return sceneJson
  }
  for (const el of s.elements ?? []) {
    if (!baseIds.has(String(el.id))) {
      const cd = (el.customData as Record<string, unknown> | undefined) ?? {}
      el.customData = { ...cd, [ANNOTATION_KEY]: true }
    }
  }
  return JSON.stringify(s)
}

/** Save a guest scene. Returns true on accept, false on tier rejection (403). */
export async function savePublicCanvasScene(token: string, sceneJson: string): Promise<boolean> {
  const res = await fetch(`/shared/public/canvas/${encodeURIComponent(token)}/scene`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scene: sceneJson }),
  })
  return res.ok
}
