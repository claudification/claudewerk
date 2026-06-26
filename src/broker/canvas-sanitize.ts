/**
 * Canvas scene sanitizer -- runs on EVERY save and on every inbound remote/guest
 * delta (Phase D/E). Mandatory for public sharing, applied to authed saves too
 * (defense in depth). Mirrors the recap public-share-sanitize discipline.
 *
 * Threat: Excalidraw `embeddable` / `iframe` elements render arbitrary URLs in an
 * iframe inside the canvas; a `link` on any element can carry a javascript: URI.
 * A malicious client (or a public editor) could inject HTML / script that way.
 * We DROP embed elements and strip dangerous links, allowlist-style.
 *
 * The parse is defensive: malformed JSON -> reject (caller keeps the prior scene).
 */

import type { CanvasShareTier } from '../shared/protocol'

/** Element types that render external/embedded content -- never persisted. */
const FORBIDDEN_TYPES = new Set(['embeddable', 'iframe'])

/** customData flag marking an element as a guest annotation (comment tier).
 *  A `comment`-tier peer may only add/modify/remove elements carrying this. */
export const CANVAS_ANNOTATION_KEY = 'canvasAnnotation'

function isSafeLink(link: unknown): boolean {
  if (typeof link !== 'string') return false
  const v = link.trim().toLowerCase()
  // Allow http(s) and same-origin relative links; drop javascript:/data:/vbscript: etc.
  return v.startsWith('http://') || v.startsWith('https://') || v.startsWith('/')
}

export interface SanitizeResult {
  /** Sanitized scene JSON string (re-serialized), or null when input was unparseable. */
  json: string | null
  /** Count of elements removed. */
  droppedElements: number
  /** Count of links stripped from surviving elements. */
  strippedLinks: number
}

/**
 * Sanitize a serialized Excalidraw scene. Drops embed elements, strips unsafe
 * links. Returns re-serialized JSON (or null if the input could not be parsed).
 */
export function sanitizeCanvasScene(raw: string): SanitizeResult {
  let scene: Record<string, unknown>
  try {
    scene = JSON.parse(raw)
  } catch {
    return { json: null, droppedElements: 0, strippedLinks: 0 }
  }
  if (!scene || typeof scene !== 'object') {
    return { json: null, droppedElements: 0, strippedLinks: 0 }
  }

  let droppedElements = 0
  let strippedLinks = 0

  const elements = Array.isArray(scene.elements) ? scene.elements : []
  const cleaned = elements.filter((el): el is Record<string, unknown> => {
    if (!el || typeof el !== 'object') return false
    const type = (el as Record<string, unknown>).type
    if (typeof type === 'string' && FORBIDDEN_TYPES.has(type)) {
      droppedElements++
      return false
    }
    return true
  })

  for (const el of cleaned) {
    if ('link' in el && el.link != null && !isSafeLink(el.link)) {
      el.link = null
      strippedLinks++
    }
  }

  scene.elements = cleaned
  return { json: JSON.stringify(scene), droppedElements, strippedLinks }
}

/** Is this element a guest annotation (customData.canvasAnnotation === true)? */
function isAnnotation(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const cd = (el as Record<string, unknown>).customData
  return !!cd && typeof cd === 'object' && (cd as Record<string, unknown>)[CANVAS_ANNOTATION_KEY] === true
}

/** Stable signature of the non-annotation (base) elements, keyed by id and
 *  Excalidraw's monotonic `version`. Two scenes with an identical signature have
 *  the same base design; any base add/remove/edit changes a version or the id set. */
function baseSignature(raw: string): string | null {
  let scene: Record<string, unknown>
  try {
    scene = JSON.parse(raw)
  } catch {
    return null
  }
  const elements = Array.isArray(scene?.elements) ? scene.elements : []
  const sig = elements
    .filter(el => !isAnnotation(el))
    .map(el => {
      const e = el as Record<string, unknown>
      return `${String(e.id)}:${String(e.version ?? '')}`
    })
    .sort()
  return sig.join('|')
}

export interface TierEnforceResult {
  /** true if the proposed scene is allowed under the tier. */
  ok: boolean
  /** Sanitized scene JSON to persist when ok (embeds/links already stripped). */
  json?: string
  /** Reason for rejection (for logging / 403 detail). */
  reason?: string
}

/**
 * Gate a proposed scene write from a SHARE GUEST by their permission tier.
 * Owner/authed saves never go through here -- they use sanitizeCanvasScene directly.
 *
 *   read    -> no writes at all.
 *   comment -> may only add/modify/remove annotation elements
 *              (customData.canvasAnnotation); any change to a base element rejected.
 *   edit    -> full co-edit; scene accepted after embed/link sanitize.
 *
 * `prevRaw` is the current stored scene (the baseline a comment peer must preserve).
 */
export function enforceCanvasTier(prevRaw: string, nextRaw: string, tier: CanvasShareTier): TierEnforceResult {
  if (tier === 'read') return { ok: false, reason: 'read-only share' }

  const clean = sanitizeCanvasScene(nextRaw)
  if (clean.json === null) return { ok: false, reason: 'invalid scene JSON' }

  if (tier === 'edit') return { ok: true, json: clean.json }

  // comment: base design must be untouched -- only annotation elements may differ.
  const prevSig = baseSignature(prevRaw)
  const nextSig = baseSignature(clean.json)
  if (prevSig === null || nextSig === null) return { ok: false, reason: 'unparseable scene' }
  if (prevSig !== nextSig) return { ok: false, reason: 'comment tier may not modify the base design' }
  return { ok: true, json: clean.json }
}
