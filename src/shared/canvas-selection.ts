/**
 * SELECTION AS CONTEXT -- summarizing what the user has selected on a canvas so
 * the connected agent can act on "make these blue".
 *
 * Shared (not web-only) because the broker validates the payload and the agent
 * host renders it into the `<channel>` block; all three need the same shape.
 *
 * The whole design problem here is SIZE. A raw Excalidraw element is 400-900
 * bytes of geometry, seeds, version nonces and binding tables, almost none of
 * which helps a model answer "make these blue". Fifty selected elements of raw
 * JSON is tens of thousands of tokens for a one-line request. So:
 *
 *   - keep what a request can REFER to: id (to address it), type (to describe
 *     it), text (to recognize it), colours (most requests are about colour),
 *     rounded geometry (for "the one on the left", "make them line up");
 *   - drop everything else;
 *   - past MAX_DETAILED elements, stop listing individuals entirely and send a
 *     census instead -- at that size the user means "all of these", and a type
 *     histogram conveys that better than 200 truncated rows.
 */

/** Beyond this many selected elements we summarize instead of listing. Chosen
 *  so a full listing stays a few hundred tokens: past it, individual ids are
 *  noise the model cannot act on one-by-one anyway. */
export const MAX_DETAILED_ELEMENTS = 25

/** Longest inline text per element. Enough to recognize a label or a heading;
 *  a wall of text in one sticky is not context, it is the canvas's content. */
export const MAX_TEXT_CHARS = 80

/** The subset of an Excalidraw element this module reads. Structural typing so
 *  callers can pass raw scene elements without casting. */
export interface CanvasElementLike {
  id?: unknown
  type?: unknown
  text?: unknown
  label?: unknown
  strokeColor?: unknown
  backgroundColor?: unknown
  x?: unknown
  y?: unknown
  width?: unknown
  height?: unknown
  isDeleted?: unknown
}

/** One selected element, as the agent sees it. */
export interface SelectedElement {
  id: string
  type: string
  /** Present only when the element actually carries text. */
  text?: string
  strokeColor?: string
  backgroundColor?: string
  /** Rounded to whole pixels -- sub-pixel precision is never part of a request. */
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface CanvasSelection {
  /** How many elements are selected in total (NOT how many are listed). */
  count: number
  /** The elements themselves, empty once past MAX_DETAILED_ELEMENTS. */
  elements: SelectedElement[]
  /** type -> count, set ONLY when the listing was dropped for being too large. */
  histogram?: Record<string, number>
  /** True when `elements` is a summary rather than the full selection. */
  truncated: boolean
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined
}

/** Text carried by an element, truncated with an ellipsis when long. */
function elementText(el: CanvasElementLike): string | undefined {
  const raw = str(el.text) ?? str(el.label)
  if (!raw) return undefined
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > MAX_TEXT_CHARS ? `${flat.slice(0, MAX_TEXT_CHARS)}...` : flat
}

function toSelected(el: CanvasElementLike): SelectedElement | null {
  const id = str(el.id)
  if (!id) return null
  return {
    id,
    type: str(el.type) ?? 'unknown',
    text: elementText(el),
    strokeColor: str(el.strokeColor),
    backgroundColor: str(el.backgroundColor),
    x: num(el.x),
    y: num(el.y),
    width: num(el.width),
    height: num(el.height),
  }
}

function histogramOf(elements: CanvasElementLike[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const el of elements) {
    const type = str(el.type) ?? 'unknown'
    counts[type] = (counts[type] ?? 0) + 1
  }
  return counts
}

/**
 * Build the selection payload from the scene's elements and the ids the user has
 * selected. Deleted elements are excluded -- Excalidraw tombstones rather than
 * removes, and a tombstone is not something the user can point at.
 */
export function summarizeSelection(
  elements: readonly CanvasElementLike[],
  selectedIds: readonly string[],
): CanvasSelection {
  const wanted = new Set(selectedIds)
  const picked = elements.filter(el => {
    const id = str(el.id)
    return id !== undefined && wanted.has(id) && el.isDeleted !== true
  })

  if (picked.length === 0) return { count: 0, elements: [], truncated: false }
  if (picked.length > MAX_DETAILED_ELEMENTS) {
    return { count: picked.length, elements: [], histogram: histogramOf(picked), truncated: true }
  }
  return {
    count: picked.length,
    elements: picked.map(toSelected).filter((e): e is SelectedElement => e !== null),
    truncated: false,
  }
}

/** A one-line description for the chat bubble's context chip ("3 selected"). */
export function describeSelection(sel: CanvasSelection): string {
  if (sel.count === 0) return 'nothing selected'
  if (!sel.truncated && sel.elements.length <= 3) {
    return sel.elements.map(e => e.text ?? e.type).join(', ')
  }
  return `${sel.count} selected`
}

/** Escape the few characters that would break out of an XML attribute/body. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function selectedTag(el: SelectedElement): string {
  const attrs = [`id="${xmlEscape(el.id)}"`, `type="${xmlEscape(el.type)}"`]
  if (el.strokeColor) attrs.push(`stroke="${xmlEscape(el.strokeColor)}"`)
  if (el.backgroundColor) attrs.push(`fill="${xmlEscape(el.backgroundColor)}"`)
  if (el.x !== undefined && el.y !== undefined) attrs.push(`at="${el.x},${el.y}"`)
  if (el.width !== undefined && el.height !== undefined) attrs.push(`size="${el.width}x${el.height}"`)
  const body = el.text ? xmlEscape(el.text) : ''
  return `  <selected ${attrs.join(' ')}>${body}</selected>`
}

/**
 * Render the selection as the `<selected>` lines that ride inside the `<channel>`
 * wrapper -- the shape the feature was specified with.
 *
 * Returns '' for an empty selection so the wrapper stays clean when the user is
 * just talking rather than pointing at something. A truncated selection renders
 * as ONE census line instead of a listing: the model gets the size and the mix,
 * which is what it can act on at that scale.
 */
export function renderSelectionBlock(sel: CanvasSelection | undefined): string {
  if (!sel || sel.count === 0) return ''
  if (sel.truncated) {
    const mix = Object.entries(sel.histogram ?? {})
      .map(([type, n]) => `${n} ${type}`)
      .join(', ')
    return `  <selected count="${sel.count}" summary="${xmlEscape(mix)}" />`
  }
  return sel.elements.map(selectedTag).join('\n')
}
