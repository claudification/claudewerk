/**
 * Draw block (tldraw whiteboard) -- shared constants + the submit-state shape.
 *
 * A drawing is a tldraw STORE SNAPSHOT (the JSON `getSnapshot()` returns).
 * Small drawings ride inline in the dialog form state; large ones spill to the
 * broker blob store (`POST /api/files`, same as uploaded images) and ride as a
 * URL reference so the WS event + persisted snapshot stay small.
 */

/**
 * A single drawing up to this size rides inline; larger ones spill to a blob
 * file and ride as a URL reference ("256k is okay" inline). It doubles as the
 * UI warn threshold: the size meter flags a drawing over this as "saved as file"
 * so a spill is never a surprise.
 */
export const DRAW_INLINE_MAX = 256 * 1024

/** Small drawing: the tldraw snapshot rides inline in the form state. */
export interface DrawInlineValue {
  kind: 'draw'
  /** tldraw store snapshot as a JSON string. */
  snapshot: string
  bytes: number
}

/** Large drawing: snapshot spilled to a blob; only the URL rides the wire. */
export interface DrawRefValue {
  kind: 'draw-ref'
  /** Blob URL holding the tldraw snapshot JSON. */
  url: string
  bytes: number
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
