/**
 * Draw block (Excalidraw whiteboard) -- shared constants + the submit-state shape.
 *
 * A drawing is an Excalidraw SCENE (the JSON `serializeAsJSON()` returns: elements
 * + appState + files). Small drawings ride inline in the dialog form state; large
 * ones spill to the broker blob store (`POST /api/files`, same as uploaded images)
 * and ride as a URL reference so the WS event + persisted scene stay small.
 */

/**
 * A single drawing up to this size rides inline; larger ones spill to a blob
 * file and ride as a URL reference ("256k is okay" inline). It doubles as the
 * UI warn threshold: the size meter flags a drawing over this as "saved as file"
 * so a spill is never a surprise.
 */
export const DRAW_INLINE_MAX = 256 * 1024

/** Small drawing: the Excalidraw scene rides inline in the form state. */
export interface DrawInlineValue {
  kind: 'draw'
  /** Excalidraw scene as a JSON string. */
  snapshot: string
  bytes: number
  /** Blob URL of a PNG render of the scene, attached on submit for the transcript thumbnail. */
  thumbUrl?: string
}

/** Large drawing: snapshot spilled to a blob; only the URL rides the wire. */
export interface DrawRefValue {
  kind: 'draw-ref'
  /** Blob URL holding the Excalidraw scene JSON. */
  url: string
  bytes: number
  /** Blob URL of a PNG render of the scene, attached on submit for the transcript thumbnail. */
  thumbUrl?: string
}

export type DrawValue = DrawInlineValue | DrawRefValue

export function isDrawValue(v: unknown): v is DrawValue {
  if (!v || typeof v !== 'object') return false
  const k = (v as { kind?: unknown }).kind
  return k === 'draw' || k === 'draw-ref'
}

/** UTF-8 byte length of a string (snapshot sizing). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}
