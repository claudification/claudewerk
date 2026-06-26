/**
 * Canvas reference tokens -- the `<canvas id="...">name</canvas>` wrapper produced
 * by the `!c:` completer. Thin per-tag wrapper over the generic codec in xml-ref.ts
 * (shared with conversation-refs.ts). SINGLE SOURCE OF TRUTH for the canvas token
 * shape -- the CM6 pill widget, the completer, and the markdown renderer build/parse
 * through here.
 */

import { makeXmlRefCodec } from './xml-ref'

const codec = makeXmlRefCodec('canvas')

/** Build the canonical reference token for a canvas. */
export const buildCanvasRef = codec.build
/** Parse every canvas reference out of `text`, in document order. */
export const parseCanvasRefs = codec.parse
/** Match a canvas reference at the START of `src`, or null. */
export const matchLeadingCanvasRef = codec.matchLeading
